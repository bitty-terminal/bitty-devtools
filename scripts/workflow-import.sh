#!/usr/bin/env bash
# workflow-import.sh — restore the local CarryCtx DB from the in-repo snapshot.
#
# In-repo restore (no mirror repository): fetches the publication branch
# `refs/heads/carryctx-snapshots` from the remote, then runs the native
# `carryctx import --from-git <ref> --mode replace --yes`. CarryCtx never
# touches the network, so this target fetches the branch itself.
#
# Safety (thin, no Python):
#   - refuses to replace any non-empty local DB (project or durable rows)
#     without --force, leaving the DB untouched;
#   - initializes an absent or known-empty CarryCtx state before import;
#   - --dry-run validates the snapshot and writes nothing;
#   - restores the committed `.carryctx/config.toml` byte-identically, because
#     `carryctx import` rewrites it with current config defaults;
#   - prints snapshot provenance (commit, export id, CarryCtx-Source trailer).
#
# Usage:
#   scripts/workflow-import.sh [--force] [--dry-run] [--project DIR]
#                              [--remote NAME] [--git-timeout SECS] [--help]
#   --force            replace a non-empty local DB.
#   --dry-run          fetch + validate only; no DB write.
#   --project DIR      repository to restore (default: this checkout root).
#   --remote NAME      git remote to fetch from (default: origin).
#   --git-timeout SECS timeout for every carryctx/git op (default: 120).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAP_BRANCH="refs/heads/carryctx-snapshots"
PROJECT="$REPO_ROOT"
REMOTE="${WORKFLOW_REMOTE:-origin}"
GIT_TIMEOUT="${GIT_TIMEOUT:-120}"
MAX_SCHEMA_TABLES=256
MAX_SCHEMA_NAME_BYTES=256
MAX_SCHEMA_OBJECTS=512
MAX_SCHEMA_LINE_BYTES=131072
REQUIRED_CARRYCTX_VERSION="0.11.6"
REQUIRED_DB_SCHEMA=18
REQUIRED_CTXPACK_FORMAT="carryctx-pack-dir"
REQUIRED_CTXPACK_FORMAT_VERSION=2
SNAPSHOT_RETRIES=3
MAX_DUMP_BYTES=67108864
DRY_RUN_REF="refs/heads/carryctx-snapshots"
SETSID_MODE=""
FORCE=0
DRY_RUN=0

usage() {
	sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d'
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--force)
		FORCE=1
		shift
		;;
	--dry-run)
		DRY_RUN=1
		shift
		;;
	--project)
		PROJECT="${2:?--project requires a directory}"
		shift 2
		;;
	--project=*)
		PROJECT="${1#--project=}"
		shift
		;;
	--remote)
		REMOTE="${2:?--remote requires a name}"
		shift 2
		;;
	--remote=*)
		REMOTE="${1#--remote=}"
		shift
		;;
	--git-timeout)
		GIT_TIMEOUT="${2:?--git-timeout requires seconds}"
		shift 2
		;;
	--git-timeout=*)
		GIT_TIMEOUT="${1#--git-timeout=}"
		shift
		;;
	--help | -h)
		usage
		exit 0
		;;
	*)
		echo "workflow-import: FAIL: unknown flag $1 (see --help)" >&2
		exit 2
		;;
	esac
done

fail() {
	echo "workflow-import: FAIL: $1" >&2
	exit 1
}

log() {
	echo "workflow-import: $1"
}

warn() {
	echo "workflow-import: WARN: $1" >&2
}

have() { command -v "$1" >/dev/null 2>&1; }

run_timed() {
	local seconds="$1" leader status=0 timer_pid status_fifo release_fifo wrapper
	shift
	status_fifo="$TMP_ROOT/timed-status.$$.$RANDOM"
	release_fifo="$TMP_ROOT/timed-release.$$.$RANDOM"
	rm -f "$status_fifo" "$release_fifo"
	mkfifo "$status_fifo" "$release_fifo" || return 1
	if ! exec 7<>"$status_fifo"; then
		rm -f "$status_fifo" "$release_fifo"
		return 1
	fi
	if ! exec 8<>"$release_fifo"; then
		exec 7>&-
		rm -f "$status_fifo" "$release_fifo"
		return 1
	fi
	if [[ -z "$SETSID_MODE" ]]; then
		if have setsid && setsid --wait -- true >/dev/null 2>&1; then
			SETSID_MODE="wait"
		elif have setsid && setsid true >/dev/null 2>&1; then
			SETSID_MODE="direct"
		else
			SETSID_MODE="job-control"
		fi
	fi
	wrapper='
child=
command_status=0
terminate() {
	trap - TERM INT
	(
		sleep 1
		kill -KILL -- -$$ 2>/dev/null || :
	) &
	escalation=$!
	if [[ -n "$child" ]]; then
		wait "$child" 2>/dev/null || :
	fi
	wait "$escalation" 2>/dev/null || :
	exit 143
}
trap terminate TERM INT
"$@" 7>&- 8>&- &
child=$!
wait "$child" || command_status=$?
printf "%s\n" "$command_status" >&7
IFS= read -r _ <&8 || :
exit "$command_status"
'
	if [[ "$SETSID_MODE" == "wait" ]]; then
		setsid --wait -- bash -c "$wrapper" bash "$@" 7>&7 8>&8 &
	elif [[ "$SETSID_MODE" == "direct" ]]; then
		setsid bash -c "$wrapper" bash "$@" 7>&7 8>&8 &
	else
		set -m
		bash -c "$wrapper" bash "$@" 7>&7 8>&8 &
		set +m
	fi
	leader=$!
	(
		if IFS= read -r -t "$seconds" _ <&7; then
			printf 'release\n' >&8 || :
		else
			kill -TERM -- "-$leader" 2>/dev/null || :
		fi
	) >/dev/null 2>&1 &
	timer_pid=$!
	wait "$leader" || status=$?
	printf 'release\n' >&8 || :
	wait "$timer_pid" 2>/dev/null || :
	exec 7>&- 8>&-
	rm -f "$status_fifo" "$release_fifo"
	if [[ "$status" -eq 137 || "$status" -eq 143 ]]; then
		return 124
	fi
	return "$status"
}

path_has_symlink() {
	local current="$1"
	while [[ -n "$current" && "$current" != "/" ]]; do
		if [[ -L "$current" ]]; then
			return 0
		fi
		current="$(dirname "$current")"
	done
	[[ -L "/" ]] && return 0
	return 1
}

assert_project_paths() {
	local carryctx_dir="$PROJECT/.carryctx"
	if path_has_symlink "$PROJECT" || path_has_symlink "$CFG"; then
		return 1
	fi
	[[ -d "$PROJECT" && ! -L "$PROJECT" ]] || return 1
	if [[ -e "$carryctx_dir" || -L "$carryctx_dir" ]]; then
		[[ -d "$carryctx_dir" && ! -L "$carryctx_dir" ]] || return 1
	fi
	if [[ -e "$CFG" || -L "$CFG" ]]; then
		[[ -f "$CFG" && ! -L "$CFG" ]] || return 1
	fi
	return 0
}

path_identity() {
	local path="$1" value
	if value="$(stat -c '%d:%i' -- "$path" 2>/dev/null)"; then
		printf '%s\n' "$value"
		return 0
	fi
	if value="$(stat -f '%d:%i' -- "$path" 2>/dev/null)"; then
		printf '%s\n' "$value"
		return 0
	fi
	return 1
}

capture_path_identity() {
	local path="$1"
	if [[ -e "$path" || -L "$path" ]]; then
		path_identity "$path"
	else
		printf '\n'
	fi
}

assert_captured_path() {
	local path="$1" expected="$2" current
	if [[ -n "$expected" ]]; then
		[[ -e "$path" && ! -L "$path" ]] || return 1
		current="$(path_identity "$path" 2>/dev/null)" || return 1
		[[ "$current" == "$expected" ]] || return 1
	else
		[[ ! -e "$path" && ! -L "$path" ]] || return 1
	fi
	return 0
}

assert_stable_paths() {
	assert_project_paths || return 1
	assert_captured_path "$PROJECT" "$PROJECT_ID" || return 1
	assert_captured_path "$GIT_COMMON" "$GIT_COMMON_ID" || return 1
	assert_captured_path "$CARRYCTX_DIR" "$CARRYCTX_DIR_ID" || return 1
	assert_captured_path "$CFG" "$CFG_ID" || return 1
	assert_captured_path "$DB" "$DB_ID" || return 1
	assert_captured_path "$DB-wal" "$DB_WAL_ID" || return 1
	assert_captured_path "$DB-shm" "$DB_SHM_ID" || return 1
	[[ ! -e "$DB-journal" && ! -L "$DB-journal" ]] || return 1
	return 0
}

have git || fail "git not on PATH"
have carryctx || fail "carryctx not on PATH"
have awk || fail "awk not on PATH"
have mkfifo || fail "mkfifo not on PATH"
have cp || fail "cp not on PATH"
have mv || fail "mv not on PATH"
have cmp || fail "cmp not on PATH"
have wc || fail "wc not on PATH"
have stat || fail "stat not on PATH"
have sleep || fail "sleep not on PATH"
[[ "$GIT_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || fail "git timeout must be a positive integer"

PROJECT_LOGICAL="$(cd -L "$PROJECT" 2>/dev/null && pwd -L)" ||
	fail "project directory $PROJECT not found"
PROJECT="$(cd -P "$PROJECT" 2>/dev/null && pwd -P)" ||
	fail "project directory $PROJECT not found"
[[ "$PROJECT_LOGICAL" == "$PROJECT" ]] ||
	fail "project path contains a symlink"
CFG="$PROJECT/.carryctx/config.toml"
assert_project_paths || fail "unsafe CarryCtx configuration path"
TRACK_REF="refs/remotes/$REMOTE/carryctx-snapshots"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/workflow-import.XXXXXX")"
TMP_ROOT="$(cd -P "$TMP_ROOT" && pwd -P)" || fail "cannot resolve temporary workflow directory"
CFG_BACKUP=""
RESTORE_FAILED=0
AUTHORITY_DB=""
AUTHORITY_SCHEMA=""
DRY_RUN_PROJECT=""
VERSION_CONTRACT=""
VERSION_CONTRACT_READY=0
PRE_IMPORT_ROOT=""
PRE_IMPORT_DB=""
PRE_IMPORT_DUMP=""
PRE_IMPORT_RAW_DUMP=""
IMPORT_STAGING_PROJECT=""
IMPORT_STAGING_COMMON=""
IMPORT_STAGING_REF="refs/heads/workflow-import-snapshot"
IMPORT_GUARD_DB=""
HANDOFF_DB_ID=""
HANDOFF_WAL_ID=""
HANDOFF_SHM_ID=""
AUTHORITY_MIGRATIONS=""
PROBE_RESULT=""
PROBE_SNAPSHOT=""
PROJECT_ID=""
GIT_COMMON_ID=""
CARRYCTX_DIR_ID=""
CFG_ID=""
DB_ID=""
DB_WAL_ID=""
DB_SHM_ID=""
restore_config() {
	if [[ -n "$CFG_BACKUP" ]]; then
		if ! assert_project_paths || [[ ! -f "$CFG_BACKUP" || -L "$CFG_BACKUP" ]]; then
			RESTORE_FAILED=1
			warn "cannot restore $CFG through an unsafe path; recovery backup retained at $CFG_BACKUP"
			return 1
		fi
		if ! cmp -s "$CFG_BACKUP" "$CFG"; then
			if [[ ! -d "$PROJECT/.carryctx" ]] && ! mkdir "$PROJECT/.carryctx"; then
				RESTORE_FAILED=1
				warn "cannot restore $CFG; recovery backup retained at $CFG_BACKUP"
				return 1
			fi
			if ! cp -p -- "$CFG_BACKUP" "$CFG"; then
				RESTORE_FAILED=1
				warn "cannot restore $CFG; recovery backup retained at $CFG_BACKUP"
				return 1
			fi
			if ! cmp -s -- "$CFG_BACKUP" "$CFG"; then
				RESTORE_FAILED=1
				warn "cannot restore $CFG; recovery backup retained at $CFG_BACKUP"
				return 1
			fi
			log "restored pre-existing .carryctx/config.toml (import rewrites local config defaults)"
		fi
	fi
}
cleanup() {
	local status=$?
	if [[ "$RESTORE_FAILED" == 1 ]] || ! restore_config; then
		exit 1
	fi
	rm -rf "$TMP_ROOT"
	exit "$status"
}
trap cleanup EXIT

sqlite_query() {
	local db="$1" sql="$2"
	run_timed "$GIT_TIMEOUT" sqlite3 -readonly -batch -noheader -separator '|' "$db" "$sql"
}

dump_database() {
	local db="$1" output="$2" canonical="$2.vacuum.sqlite" size parameter_path
	rm -f "$canonical"
	parameter_path="${canonical//\'/\'\'}"
	if ! run_timed "$GIT_TIMEOUT" sqlite3 -readonly -batch \
		-cmd '.parameter init' \
		-cmd ".parameter set @out '$parameter_path'" \
		-cmd 'VACUUM INTO @out;' "$db"; then
		rm -f "$canonical"
		return 1
	fi
	[[ -f "$canonical" && ! -L "$canonical" ]] || {
		rm -f "$canonical"
		return 1
	}
	if ! run_timed "$GIT_TIMEOUT" sqlite3 -readonly -batch "$canonical" .dump >"$output" 2>/dev/null; then
		rm -f "$canonical"
		return 1
	fi
	size="$(wc -c <"$output")" || {
		rm -f "$canonical"
		return 1
	}
	[[ "$size" =~ ^[0-9]+$ ]] || {
		rm -f "$canonical"
		return 1
	}
	((size > 0 && size <= MAX_DUMP_BYTES)) || {
		rm -f "$canonical"
		return 1
	}
	rm -f "$canonical"
	return 0
}

dump_raw_database() {
	local db="$1" output="$2" size
	rm -f "$output"
	if ! run_timed "$GIT_TIMEOUT" sqlite3 -readonly -batch "$db" .dump >"$output" 2>/dev/null; then
		return 1
	fi
	size="$(wc -c <"$output")" || return 1
	[[ "$size" =~ ^[0-9]+$ ]] || return 1
	((size > 0 && size <= MAX_DUMP_BYTES))
}

prepare_version_contract() {
	local root="$TMP_ROOT/version-contract" timeout="$GIT_TIMEOUT" project
	project="$root/project"
	mkdir -p "$root/home" "$root/data" "$root/config" "$root/state" "$root/cache" || return 1
	if ! (
		for name in ${!GIT_@}; do
			unset "$name"
		done
		for name in ${!CARRYCTX_@}; do
			unset "$name"
		done
		export HOME="$root/home"
		export GIT_CONFIG_NOSYSTEM=1
		export XDG_CONFIG_HOME="$root/config"
		export XDG_DATA_HOME="$root/data"
		export XDG_STATE_HOME="$root/state"
		export XDG_CACHE_HOME="$root/cache"
		run_timed "$timeout" git init --quiet "$project"
		run_timed "$timeout" carryctx version --json --project "$project"
	) >"$TMP_ROOT/version.json" 2>"$TMP_ROOT/version.err"; then
		return 1
	fi
	VERSION_CONTRACT="$(<"$TMP_ROOT/version.json")" || return 1
	[[ -n "$VERSION_CONTRACT" ]] || return 1
	VERSION_CONTRACT_READY=1
	return 0
}

carryctx_schema_version() {
	local output version
	[[ "$VERSION_CONTRACT_READY" == 1 && -n "$VERSION_CONTRACT" ]] || return 1
	output="$VERSION_CONTRACT"
	if [[ "$output" == *$'\n'* || "$output" == *$'\r'* ]]; then
		return 1
	fi
	if ! version="$(printf '%s' "$output" | LC_ALL=C awk -v required_version="$REQUIRED_CARRYCTX_VERSION" -v required_schema="$REQUIRED_DB_SCHEMA" -v required_format="$REQUIRED_CTXPACK_FORMAT" -v required_format_version="$REQUIRED_CTXPACK_FORMAT_VERSION" '
BEGIN {
	pattern = "^[{]\"schema_version\":1,\"command\":\"version\",\"success\":true,\"data\":[{]\"contract_versions\":[{]\"cli\":\"[0-9A-Za-z._-]+\",\"ctxpack_format\":[{]\"format\":\"[0-9A-Za-z._-]+\",\"format_version\":[0-9]+[}],\"db_schema\":[0-9]+,\"skill_surface\":[{]\"min_carryctx\":\"[0-9A-Za-z._-]+\",\"skill\":\"[0-9A-Za-z._-]+\",\"version\":\"[0-9A-Za-z._-]+\"[}][}]},\"meta\":[{]\"timestamp\":\"[0-9T:.+Z-]+\"[}]}$"
}
{
	if (match($0, pattern) == 0) exit 1
	matched = substr($0, RSTART, RLENGTH)
	if (match(matched, /"cli":"[^"]+"/) == 0) exit 1
	cli = substr(matched, RSTART, RLENGTH)
	sub(/^"cli":"/, "", cli)
	sub(/"$/, "", cli)
	if (cli != required_version) exit 1
	if (match(matched, /"min_carryctx":"[^"]+"/) == 0) exit 1
	min_version = substr(matched, RSTART, RLENGTH)
	sub(/^"min_carryctx":"/, "", min_version)
	sub(/"$/, "", min_version)
	if (min_version != required_version) exit 1
	if (match(matched, /"db_schema":[0-9]+/) == 0) exit 1
	schema = substr(matched, RSTART, RLENGTH)
	sub(/^"db_schema":/, "", schema)
	if (schema != required_schema) exit 1
	if (match(matched, /"format":"[^"]+"/) == 0) exit 1
	format = substr(matched, RSTART, RLENGTH)
	sub(/^"format":"/, "", format)
	sub(/"$/, "", format)
	if (format != required_format) exit 1
	if (match(matched, /"format_version":[0-9]+/) == 0) exit 1
	format_version = substr(matched, RSTART, RLENGTH)
	sub(/^"format_version":/, "", format_version)
	if (format_version != required_format_version) exit 1
	print schema
	exit 0
}
')"; then
		return 1
	fi
	[[ "$version" == "$REQUIRED_DB_SCHEMA" ]] || return 1
	printf '%s\n' "$version"
}

decode_hex_name() {
	local hex="$1" octal output="" index
	[[ "$hex" =~ ^[0-9A-Fa-f]+$ ]] || return 1
	((${#hex} % 2 == 0)) || return 1
	[[ "$hex" != *"00"* ]] || return 1
	for ((index = 0; index < ${#hex}; index += 2)); do
		printf -v octal '%03o' "$((16#${hex:index:2}))"
		output+="\\$octal"
	done
	printf '%b' "$output"
}

unknown_state() {
	PROBE_RESULT="unknown 0 0"
}

is_count() {
	[[ "$1" =~ ^(0|[1-9][0-9]*)$ && "${#1}" -le 18 ]]
}

snapshot_matches_source() {
	local source="$1" slot="$2" compare_shm="$3" suffix slot_db
	slot_db="$slot/state.sqlite"
	[[ -f "$source" && ! -L "$source" && -f "$slot_db" && ! -L "$slot_db" ]] || return 1
	cmp -s -- "$source" "$slot_db" || return 1
	for suffix in -wal -shm; do
		if [[ -e "$source$suffix" || -L "$source$suffix" ]]; then
			[[ -f "$source$suffix" && ! -L "$source$suffix" ]] || return 1
			if [[ "$suffix" == "-shm" && "$compare_shm" != 1 ]]; then
				continue
			fi
			[[ -f "$slot_db$suffix" && ! -L "$slot_db$suffix" ]] || return 1
			cmp -s -- "$source$suffix" "$slot_db$suffix" || return 1
		elif [[ "$suffix" == "-wal" && "$compare_shm" != 1 ]]; then
			continue
		elif [[ "$suffix" == "-shm" && "$compare_shm" != 1 ]]; then
			continue
		elif [[ -e "$slot_db$suffix" || -L "$slot_db$suffix" ]]; then
			return 1
		fi
	done
	[[ ! -e "$source-journal" && ! -L "$source-journal" ]] || return 1
	return 0
}

copy_probe_snapshot() {
	local source="$1" slot="$2" suffix slot_db
	slot_db="$slot/state.sqlite"
	rm -rf "$slot"
	mkdir -p "$slot" || return 1
	cp -p -- "$source" "$slot_db" || return 1
	for suffix in -wal -shm; do
		if [[ -e "$source$suffix" || -L "$source$suffix" ]]; then
			[[ -f "$source$suffix" && ! -L "$source$suffix" && -r "$source$suffix" ]] || return 1
			cp -p -- "$source$suffix" "$slot_db$suffix" || return 1
		fi
	done
	snapshot_matches_source "$source" "$slot" 1
}

assert_probe_snapshot_unchanged() {
	local suffix
	if [[ -n "$PROBE_SNAPSHOT" ]]; then
		assert_captured_path "$DB" "$DB_ID" || return 1
		assert_captured_path "$DB-wal" "$DB_WAL_ID" || return 1
		assert_captured_path "$DB-shm" "$DB_SHM_ID" || return 1
		snapshot_matches_source "$DB" "$PROBE_SNAPSHOT" 0
		return
	fi
	[[ ! -e "$DB" && ! -L "$DB" ]] || return 1
	for suffix in -wal -shm -journal; do
		[[ ! -e "$DB$suffix" && ! -L "$DB$suffix" ]] || return 1
	done
}

assert_no_command_lock() {
	local locks_dir="$GIT_COMMON/carryctx/locks" lock_dir="$GIT_COMMON/carryctx/locks/command.lock"
	path_has_symlink "$locks_dir" && return 1
	if [[ -e "$locks_dir" || -L "$locks_dir" ]]; then
		[[ -d "$locks_dir" && ! -L "$locks_dir" ]] || return 1
	fi
	[[ ! -e "$lock_dir" && ! -L "$lock_dir" ]]
}

prepare_dry_run_project() {
	local root="$TMP_ROOT/dry-run" project commit timeout="$GIT_TIMEOUT"
	DRY_RUN_PROJECT="$root/project"
	project="$DRY_RUN_PROJECT"
	mkdir -p "$root/home" "$root/data" "$root/config" "$root/state" "$root/cache" || return 1
	if ! (
		for name in ${!GIT_@}; do
			unset "$name"
		done
		export HOME="$root/home"
		export GIT_CONFIG_NOSYSTEM=1
		run_timed "$timeout" git init --quiet "$project"
	); then
		return 1
	fi
	commit="$(run_timed "$GIT_TIMEOUT" git -C "$PROJECT" rev-parse "$TRACK_REF" 2>/dev/null)" || return 1
	[[ "$commit" =~ ^[0-9a-f]{40,64}$ ]] || return 1
	if ! run_timed "$GIT_TIMEOUT" git -C "$project" fetch "$PROJECT" "$commit:$DRY_RUN_REF"; then
		return 1
	fi
	if [[ -f "$CFG" ]]; then
		mkdir -p "$project/.carryctx" || return 1
		cp -p -- "$CFG" "$project/.carryctx/config.toml" || return 1
	fi
	return 0
}

run_dry_run_validation() {
	local root="$TMP_ROOT/dry-run" timeout="$GIT_TIMEOUT"
	prepare_dry_run_project || return 1
	if ! (
		for name in ${!GIT_@}; do
			unset "$name"
		done
		for name in ${!CARRYCTX_@}; do
			unset "$name"
		done
		export HOME="$root/home"
		export GIT_CONFIG_NOSYSTEM=1
		export XDG_DATA_HOME="$root/data"
		export XDG_CONFIG_HOME="$root/config"
		export XDG_STATE_HOME="$root/state"
		export XDG_CACHE_HOME="$root/cache"
		run_timed "$timeout" carryctx import --from-git "$DRY_RUN_REF" \
			--mode replace --yes --dry-run --json --project "$DRY_RUN_PROJECT"
	) >"$TMP_ROOT/dry-run.json" 2>"$TMP_ROOT/dry-run.err"; then
		return 1
	fi
	return 0
}

prepare_import_staging_project() {
	local root="$TMP_ROOT/import-staging" timeout="$GIT_TIMEOUT" project commit
	project="$root/project"
	IMPORT_STAGING_PROJECT="$project"
	IMPORT_STAGING_COMMON="$project/.git"
	mkdir -p "$root/home" "$root/data" "$root/config" "$root/state" "$root/cache" || return 1
	if ! (
		for name in ${!GIT_@}; do
			unset "$name"
		done
		export HOME="$root/home"
		export GIT_CONFIG_NOSYSTEM=1
		export XDG_CONFIG_HOME="$root/config"
		export XDG_DATA_HOME="$root/data"
		export XDG_STATE_HOME="$root/state"
		export XDG_CACHE_HOME="$root/cache"
		run_timed "$timeout" git init --quiet "$project"
	); then
		return 1
	fi
	commit="$(run_timed "$GIT_TIMEOUT" git -C "$PROJECT" rev-parse "$TRACK_REF" 2>/dev/null)" || return 1
	[[ "$commit" =~ ^[0-9a-f]{40,64}$ ]] || return 1
	if ! run_timed "$GIT_TIMEOUT" git -C "$project" fetch "$PROJECT" "$commit:$IMPORT_STAGING_REF"; then
		return 1
	fi
	if [[ -f "$CFG" ]]; then
		mkdir -p "$project/.carryctx" || return 1
		cp -p -- "$CFG" "$project/.carryctx/config.toml" || return 1
	fi
	copy_probe_snapshot "$PRE_IMPORT_DB" "$IMPORT_STAGING_COMMON/carryctx"
}

run_staging_import() {
	local root="$TMP_ROOT/import-staging" timeout="$GIT_TIMEOUT"
	prepare_import_staging_project || return 1
	if ! (
		for name in ${!GIT_@}; do
			unset "$name"
		done
		for name in ${!CARRYCTX_@}; do
			unset "$name"
		done
		export HOME="$root/home"
		export GIT_CONFIG_NOSYSTEM=1
		export XDG_CONFIG_HOME="$root/config"
		export XDG_DATA_HOME="$root/data"
		export XDG_STATE_HOME="$root/state"
		export XDG_CACHE_HOME="$root/cache"
		export WORKFLOW_IMPORT_STAGING_PROJECT="$IMPORT_STAGING_PROJECT"
		export WORKFLOW_IMPORT_STAGING_COMMON="$IMPORT_STAGING_COMMON"
		run_timed "$timeout" carryctx import --from-git "$IMPORT_STAGING_REF" \
			--mode replace --yes --json --project "$IMPORT_STAGING_PROJECT"
	) >"$TMP_ROOT/staging-import.json" 2>"$TMP_ROOT/staging-import.err"; then
		return 1
	fi
	return 0
}

reanchor_staging_project() {
	local staged_db="$IMPORT_STAGING_COMMON/carryctx/state.sqlite" root common
	root="${PROJECT//\'/\'\'}"
	common="${GIT_COMMON//\'/\'\'}"
	run_timed "$GIT_TIMEOUT" sqlite3 -batch \
		-cmd '.parameter init' \
		-cmd ".parameter set @root '$root'" \
		-cmd ".parameter set @common '$common'" \
		-cmd 'UPDATE projects SET repository_root = @root, git_common_dir = @common;' \
		"$staged_db"
}

validate_staging_import() {
	local output backup staged_db="$IMPORT_STAGING_COMMON/carryctx/state.sqlite" integrity suffix
	output="$(<"$TMP_ROOT/staging-import.json")" || return 1
	backup="$(extract_import_backup "$output")" || return 1
	validate_import_backup "$backup" "$IMPORT_STAGING_COMMON/carryctx/backups" || return 1
	dump_database "$backup" "$TMP_ROOT/staging-backup.dump" || return 1
	cmp -s -- "$PRE_IMPORT_DUMP" "$TMP_ROOT/staging-backup.dump" || return 1
	[[ -f "$staged_db" && ! -L "$staged_db" ]] || return 1
	for suffix in -wal -shm; do
		if [[ -e "$staged_db$suffix" || -L "$staged_db$suffix" ]]; then
			[[ -f "$staged_db$suffix" && ! -L "$staged_db$suffix" ]] || return 1
		fi
	done
	[[ ! -e "$staged_db-journal" && ! -L "$staged_db-journal" ]] || return 1
	integrity="$(sqlite_query "$staged_db" 'PRAGMA integrity_check;' 2>/dev/null)" || return 1
	[[ "$integrity" == "ok" && "$integrity" != *$'\n'* ]] || return 1
	dump_database "$staged_db" "$TMP_ROOT/staged-committed.dump"
}

restore_import_guard() {
	local suffix
	[[ -n "$IMPORT_GUARD_DB" && -e "$IMPORT_GUARD_DB" ]] || return 0
	if [[ -e "$DB" || -L "$DB" || -e "$DB-wal" || -L "$DB-wal" || -e "$DB-shm" || -L "$DB-shm" ]]; then
		warn "retained pre-import database at $IMPORT_GUARD_DB because the target path is occupied"
		return 0
	fi
	if ! mv -- "$IMPORT_GUARD_DB" "$DB"; then
		warn "retained pre-import database at $IMPORT_GUARD_DB; target restore was not safe"
		return 1
	fi
	for suffix in -wal -shm; do
		if [[ -e "$IMPORT_GUARD_DB$suffix" || -L "$IMPORT_GUARD_DB$suffix" ]]; then
			mv -- "$IMPORT_GUARD_DB$suffix" "$DB$suffix" || return 1
		fi
	done
	IMPORT_GUARD_DB=""
	return 0
}

assert_guard_sidecar_identity() {
	local path="$1" expected="$2" current
	if [[ -n "$expected" ]]; then
		[[ -f "$path" && ! -L "$path" ]] || return 1
		current="$(path_identity "$path" 2>/dev/null)" || return 1
		[[ "$current" == "$expected" ]]
	else
		[[ ! -e "$path" && ! -L "$path" ]]
	fi
}

dump_locked_guard() {
	local integrity="$TMP_ROOT/guard-locked-integrity" schema="$TMP_ROOT/guard-locked-schema" migrations="$TMP_ROOT/guard-locked-migrations" dump="$TMP_ROOT/guard-locked.dump" output="$TMP_ROOT/guard-locked.log" validator="$TMP_ROOT/validate-locked-guard" marker="$TMP_ROOT/guard-locked.ok" guard_path_file="$TMP_ROOT/guard-path" guard_id_file="$TMP_ROOT/guard-id" guard_id
	local integrity_path schema_path migrations_path dump_path validator_command
	integrity_path="${integrity//\'/\'\'}"
	schema_path="${schema//\'/\'\'}"
	migrations_path="${migrations//\'/\'\'}"
	dump_path="${dump//\'/\'\'}"
	[[ -f "$IMPORT_GUARD_DB" && ! -L "$IMPORT_GUARD_DB" ]] || return 1
	guard_id="$(path_identity "$IMPORT_GUARD_DB" 2>/dev/null || true)"
	[[ "$guard_id" == "$HANDOFF_DB_ID" ]] || return 1
	assert_guard_sidecar_identity "$IMPORT_GUARD_DB-wal" "$HANDOFF_WAL_ID" || return 1
	assert_guard_sidecar_identity "$IMPORT_GUARD_DB-shm" "$HANDOFF_SHM_ID" || return 1
	printf '%s\n' "$IMPORT_GUARD_DB" >"$guard_path_file" || return 1
	printf '%s\n' "$guard_id" >"$guard_id_file" || return 1
	rm -f "$integrity" "$schema" "$migrations" "$dump" "$output" "$marker" "$validator"
	cat >"$validator" <<'VALIDATOR'
set -euo pipefail
integrity="$1"
schema="$2"
migrations="$3"
dump="$4"
authority_schema="$5"
authority_migrations="$6"
pre_import_dump="$7"
guard_path_file="$8"
guard_id_file="$9"
max_dump_bytes="${10}"
marker="${11}"
for path in "$integrity" "$schema" "$migrations" "$dump" "$authority_schema" "$authority_migrations" "$pre_import_dump"; do
	[[ -f "$path" && ! -L "$path" ]]
done
[[ "$(<"$integrity")" == "ok" ]]
cmp -s -- "$authority_schema" "$schema"
cmp -s -- "$authority_migrations" "$migrations"
cmp -s -- "$pre_import_dump" "$dump"
size="$(wc -c <"$dump")"
[[ "$size" =~ ^[0-9]+$ ]]
((size > 0 && size <= max_dump_bytes))
guard_path="$(<"$guard_path_file")"
expected_guard_id="$(<"$guard_id_file")"
[[ -f "$guard_path" && ! -L "$guard_path" ]]
current_guard_id="$(stat -c '%d:%i' -- "$guard_path" 2>/dev/null)" || current_guard_id="$(stat -f '%d:%i' -- "$guard_path" 2>/dev/null)"
[[ "$current_guard_id" == "$expected_guard_id" ]]
for path in "$guard_path-wal" "$guard_path-shm"; do
	if [[ -e "$path" || -L "$path" ]]; then
		[[ -f "$path" && ! -L "$path" ]]
	fi
done
: >"$marker"
VALIDATOR
	printf -v validator_command 'bash %q %q %q %q %q %q %q %q %q %q %q %q' "$validator" "$integrity" "$schema" "$migrations" "$dump" "$AUTHORITY_SCHEMA" "$AUTHORITY_MIGRATIONS" "$PRE_IMPORT_RAW_DUMP" "$guard_path_file" "$guard_id_file" "$MAX_DUMP_BYTES" "$marker"
	if ! run_timed "$GIT_TIMEOUT" sqlite3 -batch \
		-cmd 'BEGIN IMMEDIATE;' \
		-cmd ".once '$integrity_path'" -cmd 'PRAGMA integrity_check;' \
		-cmd ".once '$schema_path'" -cmd "SELECT hex(type)||'|'||hex(name)||'|'||hex(tbl_name)||'|'||hex(COALESCE(sql,'')) FROM sqlite_master ORDER BY type,name,tbl_name;" \
		-cmd ".once '$migrations_path'" -cmd "SELECT version||'|'||hex(name)||'|'||hex(checksum) FROM schema_migrations ORDER BY version;" \
		-cmd ".once '$dump_path'" -cmd '.dump' \
		-cmd ".shell $validator_command" -cmd 'ROLLBACK;' "$IMPORT_GUARD_DB" >"$output" 2>&1; then
		cat "$output" >&2
		return 1
	fi
	[[ -f "$marker" && ! -L "$marker" ]]
}

validate_handoff_state() {
	local post="$TMP_ROOT/post-handoff" post_schema="$TMP_ROOT/post-schema" post_migrations="$TMP_ROOT/post-migrations" post_dump="$TMP_ROOT/post-handoff.dump" integrity guard_id
	assert_import_paths || return 1
	assert_no_command_lock || return 1
	assert_guard_sidecar_identity "$IMPORT_GUARD_DB-wal" "$HANDOFF_WAL_ID" || return 1
	assert_guard_sidecar_identity "$IMPORT_GUARD_DB-shm" "$HANDOFF_SHM_ID" || return 1
	guard_id="$(path_identity "$IMPORT_GUARD_DB" 2>/dev/null || true)"
	[[ "$guard_id" == "$HANDOFF_DB_ID" ]] || return 1
	snapshot_matches_source "$IMPORT_GUARD_DB" "$PRE_IMPORT_ROOT" 0 || return 1
	copy_probe_snapshot "$DB" "$post" || return 1
	integrity="$(sqlite_query "$post/state.sqlite" 'PRAGMA integrity_check;' 2>/dev/null)" || return 1
	[[ "$integrity" == "ok" && "$integrity" != *$'\n'* ]] || return 1
	write_schema_snapshot "$post/state.sqlite" "$post_schema" || return 1
	write_migration_snapshot "$post/state.sqlite" "$post_migrations" || return 1
	cmp -s -- "$AUTHORITY_SCHEMA" "$post_schema" || return 1
	cmp -s -- "$AUTHORITY_MIGRATIONS" "$post_migrations" || return 1
	dump_database "$post/state.sqlite" "$post_dump" || return 1
	cmp -s -- "$TMP_ROOT/staged-committed.dump" "$post_dump" || return 1
	dump_locked_guard
}

commit_staged_import() {
	local staged_db="$IMPORT_STAGING_COMMON/carryctx/state.sqlite" candidate guard suffix guard_id
	local candidate_db_id candidate_wal_id candidate_shm_id
	HANDOFF_DB_ID="$DB_ID"
	HANDOFF_WAL_ID="$DB_WAL_ID"
	HANDOFF_SHM_ID="$DB_SHM_ID"
	assert_stable_paths || fail "project paths changed while staging import"
	assert_no_command_lock || fail "local CarryCtx operation started while staging import"
	assert_probe_snapshot_unchanged || fail "local CarryCtx state changed while staging import"
	candidate="$CARRYCTX_DIR/.workflow-import-candidate.$$"
	guard="$CARRYCTX_DIR/.workflow-import-original.$$"
	rm -f "$candidate" "$guard"
	[[ ! -e "$candidate" && ! -L "$candidate" && ! -e "$guard" && ! -L "$guard" ]] || fail "cannot allocate import handoff paths"
	for suffix in -wal -shm; do
		[[ ! -e "$candidate$suffix" && ! -L "$candidate$suffix" && ! -e "$guard$suffix" && ! -L "$guard$suffix" ]] || fail "cannot allocate import sidecar handoff paths"
	done
	cp -p -- "$staged_db" "$candidate" || fail "cannot stage imported database beside target"
	for suffix in -wal -shm; do
		if [[ -e "$staged_db$suffix" || -L "$staged_db$suffix" ]]; then
			cp -p -- "$staged_db$suffix" "$candidate$suffix" || fail "cannot stage imported sidecar beside target"
		fi
	done
	candidate_db_id="$(capture_path_identity "$candidate")"
	candidate_wal_id="$(capture_path_identity "$candidate-wal")"
	candidate_shm_id="$(capture_path_identity "$candidate-shm")"
	if ! mv -- "$DB" "$guard"; then
		rm -f "$candidate"
		fail "cannot preserve target database before import handoff"
	fi
	IMPORT_GUARD_DB="$guard"
	for suffix in -wal -shm; do
		if [[ -e "$DB$suffix" || -L "$DB$suffix" ]]; then
			mv -- "$DB$suffix" "$guard$suffix" || {
				restore_import_guard || true
				fail "cannot preserve target sidecar before import handoff"
			}
		fi
	done
	if ! assert_guard_sidecar_identity "$guard-wal" "$DB_WAL_ID" || ! assert_guard_sidecar_identity "$guard-shm" "$DB_SHM_ID"; then
		restore_import_guard || true
		fail "target CarryCtx sidecar changed at the final import boundary; writer was preserved"
	fi
	guard_id="$(path_identity "$guard" 2>/dev/null || true)"
	if [[ "$guard_id" != "$DB_ID" ]] || ! snapshot_matches_source "$guard" "$PRE_IMPORT_ROOT" 0; then
		restore_import_guard || true
		fail "target CarryCtx state changed at the final import boundary; writer was preserved"
	fi
	for suffix in -wal -shm; do
		if [[ -e "$candidate$suffix" || -L "$candidate$suffix" ]]; then
			if [[ -e "$DB" || -L "$DB" ]]; then
				restore_import_guard || true
				fail "import handoff was refused because the target database changed; writer was preserved"
			fi
			if ! mv -n -- "$candidate$suffix" "$DB$suffix"; then
				restore_import_guard || true
				fail "cannot install imported sidecar without overwriting a concurrent writer"
			fi
			if [[ -e "$candidate$suffix" || -L "$candidate$suffix" ]]; then
				restore_import_guard || true
				fail "import sidecar handoff was refused because the target changed; writer was preserved"
			fi
		fi
	done
	if [[ -e "$DB" || -L "$DB" ]]; then
		restore_import_guard || true
		fail "import handoff was refused because the target database changed; writer was preserved"
	fi
	if ! mv -n -- "$candidate" "$DB"; then
		restore_import_guard || true
		fail "cannot install imported database without overwriting a concurrent writer"
	fi
	if [[ -e "$candidate" || ! -f "$DB" || -L "$DB" ]]; then
		restore_import_guard || true
		fail "import handoff was refused because the target database changed; writer was preserved"
	fi
	if ! assert_captured_path "$DB" "$candidate_db_id" || ! assert_captured_path "$DB-wal" "$candidate_wal_id" || ! assert_captured_path "$DB-shm" "$candidate_shm_id"; then
		fail "active database identity changed during handoff; active state and recovery guard were preserved"
	fi
	DB_ID="$(capture_path_identity "$DB")"
	DB_WAL_ID="$(capture_path_identity "$DB-wal")"
	DB_SHM_ID="$(capture_path_identity "$DB-shm")"
	log "retained pre-import database at $IMPORT_GUARD_DB"
	return 0
}

validate_hex_file() {
	local file="$1" kind="$2" line line_count=0 pattern
	if [[ "$kind" == "object" ]]; then
		pattern='^[0-9A-F]+\|[0-9A-F]+\|[0-9A-F]*\|[0-9A-F]*$'
	else
		pattern='^[1-9][0-9]*\|[0-9A-F]+\|[0-9A-F]+$'
	fi
	while IFS= read -r line || [[ -n "$line" ]]; do
		line_count=$((line_count + 1))
		((${#line} <= MAX_SCHEMA_LINE_BYTES)) || return 1
		if [[ "$kind" == "object" ]]; then
			((line_count <= MAX_SCHEMA_OBJECTS)) || return 1
		else
			((line_count <= REQUIRED_DB_SCHEMA)) || return 1
		fi
		[[ "$line" =~ $pattern ]] || return 1
	done <"$file"
	((line_count > 0)) || return 1
	return 0
}

write_schema_snapshot() {
	local db="$1" output="$2"
	sqlite_query "$db" "SELECT hex(type)||'|'||hex(name)||'|'||hex(tbl_name)||'|'||hex(COALESCE(sql,'')) FROM sqlite_master ORDER BY type,name,tbl_name;" >"$output" 2>/dev/null || return 1
	validate_hex_file "$output" object
}

write_migration_snapshot() {
	local db="$1" output="$2"
	sqlite_query "$db" "SELECT version||'|'||hex(name)||'|'||hex(checksum) FROM schema_migrations ORDER BY version;" >"$output" 2>/dev/null || return 1
	validate_hex_file "$output" migration
}

prepare_schema_authority() {
	local root="$TMP_ROOT/schema-authority" project authority_timeout="$GIT_TIMEOUT"
	[[ -n "$AUTHORITY_DB" ]] && return 0
	project="$root/project"
	mkdir -p "$root/home" "$root/data" "$root/config" "$root/state" "$root/cache" || return 1
	if ! (
		for name in ${!GIT_@}; do
			unset "$name"
		done
		export GIT_CONFIG_NOSYSTEM=1
		run_timed "$authority_timeout" git init --quiet "$project"
	) >"$TMP_ROOT/authority-git.log" 2>&1; then
		return 1
	fi
	if ! (
		for name in ${!GIT_@}; do
			unset "$name"
		done
		for name in ${!CARRYCTX_@}; do
			unset "$name"
		done
		export HOME="$root/home"
		export GIT_CONFIG_NOSYSTEM=1
		export XDG_DATA_HOME="$root/data"
		export XDG_CONFIG_HOME="$root/config"
		export XDG_STATE_HOME="$root/state"
		export XDG_CACHE_HOME="$root/cache"
		run_timed "$authority_timeout" carryctx init --non-interactive --minimal --project "$project"
	) >"$TMP_ROOT/authority-init.log" 2>&1; then
		return 1
	fi
	AUTHORITY_DB="$project/.git/carryctx/state.sqlite"
	[[ -f "$AUTHORITY_DB" && ! -L "$AUTHORITY_DB" ]] || return 1
	return 0
}

assert_probe_schema() {
	local target_schema="$TMP_ROOT/target-schema" target_migrations="$TMP_ROOT/target-migrations"
	local authority_schema="$TMP_ROOT/authority-schema" authority_migrations="$TMP_ROOT/authority-migrations"
	[[ -f "$PROBE_SNAPSHOT/state.sqlite" && ! -L "$PROBE_SNAPSHOT/state.sqlite" ]] || return 1
	[[ -f "$AUTHORITY_DB" && ! -L "$AUTHORITY_DB" ]] || return 1
	write_schema_snapshot "$PROBE_SNAPSHOT/state.sqlite" "$target_schema" || return 1
	write_migration_snapshot "$PROBE_SNAPSHOT/state.sqlite" "$target_migrations" || return 1
	if [[ ! -f "$AUTHORITY_SCHEMA" ]]; then
		write_schema_snapshot "$AUTHORITY_DB" "$authority_schema" || return 1
		write_migration_snapshot "$AUTHORITY_DB" "$authority_migrations" || return 1
		AUTHORITY_SCHEMA="$authority_schema"
		AUTHORITY_MIGRATIONS="$authority_migrations"
	fi
	cmp -s -- "$target_schema" "$AUTHORITY_SCHEMA" || return 1
	cmp -s -- "$target_migrations" "$AUTHORITY_MIGRATIONS"
}

extract_import_backup() {
	local output="$1"
	[[ "$output" != *$'\n'* && "$output" != *$'\r'* ]] || return 1
	printf '%s' "$output" | LC_ALL=C awk '
{
	if (index($0, "\"command\":\"import.create\"") == 0 || index($0, "\"success\":true") == 0) exit 1
	rest = $0
	count = 0
	path = ""
	while (match(rest, /"preImportBackupPath":"[^"]+"/)) {
		count++
		token = substr(rest, RSTART, RLENGTH)
		sub(/^"preImportBackupPath":"/, "", token)
		sub(/"$/, "", token)
		path = token
		rest = substr(rest, RSTART + RLENGTH)
	}
	if (count != 1) exit 1
	print path
	exit 0
}'
}

validate_import_backup() {
	local path="$1" parent="${2:-$GIT_COMMON/carryctx/backups}"
	[[ -n "$path" && "$path" != *$'\n'* && "$path" != *$'\r'* ]] || return 1
	[[ "$path" == "$parent/"* ]] || return 1
	path_has_symlink "$path" && return 1
	[[ -d "$parent" && ! -L "$parent" && -f "$path" && ! -L "$path" && -r "$path" ]]
}

assert_import_paths() {
	local suffix
	assert_project_paths || return 1
	assert_captured_path "$PROJECT" "$PROJECT_ID" || return 1
	assert_captured_path "$GIT_COMMON" "$GIT_COMMON_ID" || return 1
	assert_captured_path "$CARRYCTX_DIR" "$CARRYCTX_DIR_ID" || return 1
	[[ -f "$DB" && ! -L "$DB" ]] || return 1
	path_has_symlink "$DB" && return 1
	assert_captured_path "$DB" "$DB_ID" || return 1
	assert_captured_path "$DB-wal" "$DB_WAL_ID" || return 1
	assert_captured_path "$DB-shm" "$DB_SHM_ID" || return 1
	for suffix in -wal -shm; do
		if [[ -e "$DB$suffix" || -L "$DB$suffix" ]]; then
			[[ -f "$DB$suffix" && ! -L "$DB$suffix" && -r "$DB$suffix" ]] || return 1
		fi
	done
	[[ ! -e "$DB-journal" && ! -L "$DB-journal" ]]
}

refresh_post_stats_paths() {
	local suffix
	assert_project_paths || return 1
	assert_captured_path "$DB" "$DB_ID" || return 1
	for suffix in -wal -shm; do
		if [[ -e "$DB$suffix" || -L "$DB$suffix" ]]; then
			[[ -f "$DB$suffix" && ! -L "$DB$suffix" && -r "$DB$suffix" ]] || return 1
		fi
	done
	[[ ! -e "$DB-journal" && ! -L "$DB-journal" ]] || return 1
	DB_WAL_ID="$(capture_path_identity "$DB-wal")"
	DB_SHM_ID="$(capture_path_identity "$DB-shm")"
}

prepare_pre_import_boundary() {
	PRE_IMPORT_ROOT="$TMP_ROOT/pre-import"
	PRE_IMPORT_DB="$PRE_IMPORT_ROOT/state.sqlite"
	PRE_IMPORT_DUMP="$TMP_ROOT/pre-import.dump"
	copy_probe_snapshot "$PROBE_SNAPSHOT/state.sqlite" "$PRE_IMPORT_ROOT" || return 1
	dump_database "$PRE_IMPORT_DB" "$PRE_IMPORT_DUMP" || return 1
	PRE_IMPORT_RAW_DUMP="$TMP_ROOT/pre-import-raw.dump"
	dump_raw_database "$PRE_IMPORT_DB" "$PRE_IMPORT_RAW_DUMP" || return 1
	assert_stable_paths || return 1
	assert_no_command_lock || return 1
	assert_probe_snapshot_unchanged || return 1
	return 0
}

probe_state() {
	local db="$1" expected integrity schema_line table_rows table_summary project_line foreign_keys
	local table encoded count suffix data_expr="" seen="" table_count=0 projects=0 rows=0 has_migrations=0 has_projects=0
	local schema_count schema_min schema_max schema_distinct schema_invalid
	local project_count project_invalid table_total table_distinct table_long table_newline
	local attempt slot

	PROBE_RESULT=""
	PROBE_SNAPSHOT=""
	if [[ -e "$db-wal" || -L "$db-wal" || -e "$db-shm" || -L "$db-shm" ]]; then
		for suffix in -wal -shm; do
			if [[ -e "$db$suffix" || -L "$db$suffix" ]]; then
				[[ -f "$db$suffix" && ! -L "$db$suffix" && -r "$db$suffix" ]] || {
					unknown_state
					return 0
				}
			fi
		done
	fi
	if [[ -e "$db-journal" || -L "$db-journal" ]]; then
		unknown_state
		return 0
	fi
	if [[ ! -e "$db" && ! -L "$db" ]]; then
		for suffix in -wal -shm -journal; do
			if [[ -e "$db$suffix" || -L "$db$suffix" ]]; then
				unknown_state
				return 0
			fi
		done
		carryctx_schema_version >/dev/null || {
			unknown_state
			return 0
		}
		PROBE_RESULT="absent 0 0"
		return 0
	fi
	if [[ -L "$db" || ! -f "$db" || ! -r "$db" ]]; then
		unknown_state
		return 0
	fi
	have sqlite3 || {
		unknown_state
		return 0
	}
	expected="$(carryctx_schema_version)" || {
		unknown_state
		return 0
	}
	[[ "$expected" == "$REQUIRED_DB_SCHEMA" ]] || {
		unknown_state
		return 0
	}

	for ((attempt = 1; attempt <= SNAPSHOT_RETRIES; attempt++)); do
		slot="$(mktemp -d "$TMP_ROOT/probe.XXXXXX" 2>/dev/null)" || {
			unknown_state
			return 0
		}
		if copy_probe_snapshot "$db" "$slot"; then
			break
		fi
		rm -rf "$slot"
		slot=""
	done
	[[ -n "$slot" && -f "$slot/state.sqlite" ]] || {
		unknown_state
		return 0
	}
	local probe_db="$slot/state.sqlite"
	if ! integrity="$(sqlite_query "$probe_db" 'PRAGMA integrity_check;' 2>/dev/null)" ||
		[[ "$integrity" != "ok" || "$integrity" == *$'\n'* ]]; then
		rm -rf "$slot"
		unknown_state
		return 0
	fi
	if ! schema_line="$(sqlite_query "$probe_db" "SELECT COUNT(*), COALESCE(MIN(version), 0), COALESCE(MAX(version), 0), COUNT(DISTINCT version), COALESCE(SUM(CASE WHEN typeof(version) = 'integer' AND version > 0 AND typeof(name) = 'text' AND length(trim(name)) > 0 AND typeof(checksum) = 'text' AND length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*' AND typeof(applied_at) = 'text' AND length(trim(applied_at)) > 0 THEN 0 ELSE 1 END), 0) FROM schema_migrations;" 2>/dev/null)" ||
		[[ "$schema_line" == *$'\n'* ]]; then
		rm -rf "$slot"
		unknown_state
		return 0
	fi
	IFS='|' read -r schema_count schema_min schema_max schema_distinct schema_invalid <<<"$schema_line"
	if ! is_count "$schema_count" || ! is_count "$schema_min" || ! is_count "$schema_max" ||
		! is_count "$schema_distinct" || ! is_count "$schema_invalid" ||
		[[ "$schema_count" != "$REQUIRED_DB_SCHEMA" || "$schema_min" != "1" ||
			"$schema_max" != "$REQUIRED_DB_SCHEMA" || "$schema_distinct" != "$REQUIRED_DB_SCHEMA" ||
			"$schema_invalid" != "0" ]]; then
		rm -rf "$slot"
		unknown_state
		return 0
	fi
	if ! foreign_keys="$(sqlite_query "$probe_db" 'SELECT COUNT(*) FROM pragma_foreign_key_check;' 2>/dev/null)" ||
		! is_count "$foreign_keys" || [[ "$foreign_keys" != "0" ]]; then
		rm -rf "$slot"
		unknown_state
		return 0
	fi
	if ! project_line="$(sqlite_query "$probe_db" "SELECT COUNT(*), COALESCE(SUM(CASE WHEN typeof(id) = 'text' AND length(trim(id)) > 0 AND typeof(name) = 'text' AND length(trim(name)) > 0 AND typeof(task_prefix) = 'text' AND length(trim(task_prefix)) > 0 AND typeof(repository_root) = 'text' AND length(trim(repository_root)) > 0 AND typeof(git_common_dir) = 'text' AND length(trim(git_common_dir)) > 0 AND typeof(main_branch) = 'text' AND length(trim(main_branch)) > 0 AND typeof(schema_version) = 'integer' AND schema_version > 0 AND typeof(created_at) = 'text' AND length(trim(created_at)) > 0 AND typeof(updated_at) = 'text' AND length(trim(updated_at)) > 0 THEN 0 ELSE 1 END), 0) FROM projects;" 2>/dev/null)" ||
		[[ "$project_line" == *$'\n'* ]]; then
		rm -rf "$slot"
		unknown_state
		return 0
	fi
	IFS='|' read -r project_count project_invalid <<<"$project_line"
	if ! is_count "$project_count" || ! is_count "$project_invalid" ||
		[[ "$project_count" -gt 1 || "$project_invalid" != "0" ]]; then
		rm -rf "$slot"
		unknown_state
		return 0
	fi
	projects="$project_count"
	if ! table_summary="$(sqlite_query "$probe_db" "SELECT COUNT(*), COUNT(DISTINCT name), COALESCE(SUM(CASE WHEN length(CAST(name AS BLOB)) > $MAX_SCHEMA_NAME_BYTES THEN 1 ELSE 0 END), 0), COALESCE(SUM(CASE WHEN instr(name, char(10)) > 0 THEN 1 ELSE 0 END), 0) FROM sqlite_master WHERE type = 'table';" 2>/dev/null)" ||
		[[ "$table_summary" == *$'\n'* ]]; then
		rm -rf "$slot"
		unknown_state
		return 0
	fi
	IFS='|' read -r table_total table_distinct table_long table_newline <<<"$table_summary"
	if ! is_count "$table_total" || ! is_count "$table_distinct" || ! is_count "$table_long" || ! is_count "$table_newline" ||
		((table_total > MAX_SCHEMA_TABLES)) || [[ "$table_distinct" != "$table_total" || "$table_long" != "0" || "$table_newline" != "0" ]]; then
		rm -rf "$slot"
		unknown_state
		return 0
	fi
	if ! table_rows="$(sqlite_query "$probe_db" "SELECT hex(name) FROM sqlite_master WHERE type = 'table' ORDER BY name;" 2>/dev/null)"; then
		rm -rf "$slot"
		unknown_state
		return 0
	fi
	while IFS= read -r encoded; do
		table_count=$((table_count + 1))
		if ((table_count > MAX_SCHEMA_TABLES || ${#encoded} > MAX_SCHEMA_NAME_BYTES * 2)) || [[ -z "$encoded" || ! "$encoded" =~ ^[0-9A-Fa-f]+$ ]]; then
			rm -rf "$slot"
			unknown_state
			return 0
		fi
		if [[ "$seen" == *"|$encoded|"* ]]; then
			rm -rf "$slot"
			unknown_state
			return 0
		fi
		seen+="|$encoded|"
		if ! table="$(decode_hex_name "$encoded")" ||
			[[ -z "$table" || ! "$table" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
			rm -rf "$slot"
			unknown_state
			return 0
		fi
		case "$table" in
		schema_migrations)
			has_migrations=1
			continue
			;;
		projects)
			has_projects=1
			continue
			;;
		esac
		data_expr+="+(SELECT COUNT(*) FROM \"$table\")"
	done <<<"$table_rows"
	if [[ "$table_count" != "$table_total" || "$has_migrations" != 1 || "$has_projects" != 1 ]]; then
		rm -rf "$slot"
		unknown_state
		return 0
	fi
	if [[ -n "$data_expr" ]]; then
		if ! count="$(sqlite_query "$probe_db" "SELECT COALESCE(0${data_expr}, 0);" 2>/dev/null)" || ! is_count "$count"; then
			rm -rf "$slot"
			unknown_state
			return 0
		fi
		[[ "$count" == "0" ]] || rows=1
	fi
	if ! prepare_schema_authority; then
		rm -rf "$slot"
		unknown_state
		return 0
	fi
	PROBE_SNAPSHOT="$slot"
	if ! assert_probe_schema || ! snapshot_matches_source "$db" "$slot" 0; then
		PROBE_SNAPSHOT=""
		rm -rf "$slot"
		unknown_state
		return 0
	fi
	if [[ "$projects" == "0" && "$rows" == "0" ]]; then
		PROBE_RESULT="empty 0 0"
	else
		PROBE_RESULT="non-empty $projects $rows"
	fi
	return 0
}

if ! prepare_version_contract; then
	VERSION_CONTRACT_READY=0
fi

GIT_COMMON_RAW="$(run_timed "$GIT_TIMEOUT" git -C "$PROJECT" rev-parse --git-common-dir 2>/dev/null)" ||
	fail "cannot resolve the git common dir for $PROJECT"
[[ -n "$GIT_COMMON_RAW" && "$GIT_COMMON_RAW" != *$'\n'* ]] ||
	fail "git returned an ambiguous common directory"
if [[ "$GIT_COMMON_RAW" == /* ]]; then
	GIT_COMMON_INPUT="$GIT_COMMON_RAW"
else
	GIT_COMMON_INPUT="$PROJECT/$GIT_COMMON_RAW"
fi
GIT_COMMON_LOGICAL="$(cd -L "$GIT_COMMON_INPUT" 2>/dev/null && pwd -L)" ||
	fail "cannot resolve the git common dir for $PROJECT"
GIT_COMMON="$(cd -P "$GIT_COMMON_INPUT" 2>/dev/null && pwd -P)" ||
	fail "cannot resolve the git common dir for $PROJECT"
[[ "$GIT_COMMON_LOGICAL" == "$GIT_COMMON" ]] ||
	fail "git common directory path contains a symlink"
CARRYCTX_DIR="$GIT_COMMON/carryctx"
DB="$CARRYCTX_DIR/state.sqlite"
path_has_symlink "$DB" && fail "local CarryCtx database path contains a symlink"
path_has_symlink "$DB-wal" && fail "local CarryCtx WAL sidecar path contains a symlink"
path_has_symlink "$DB-shm" && fail "local CarryCtx SHM sidecar path contains a symlink"
PROJECT_ID="$(path_identity "$PROJECT")" || fail "cannot identify project path"
GIT_COMMON_ID="$(path_identity "$GIT_COMMON")" || fail "cannot identify git common path"
CARRYCTX_DIR_ID="$(capture_path_identity "$CARRYCTX_DIR")"
CFG_ID="$(capture_path_identity "$CFG")"
DB_ID="$(capture_path_identity "$DB")"
DB_WAL_ID="$(capture_path_identity "$DB-wal")"
DB_SHM_ID="$(capture_path_identity "$DB-shm")"
assert_stable_paths || fail "project paths changed during setup"
assert_no_command_lock || fail "local CarryCtx operation is already in progress"
probe_state "$DB" || fail "cannot inspect local CarryCtx state"
STATE_LINE="$PROBE_RESULT"
if ! read -r STATE PROJECTS ROWS <<<"$STATE_LINE" ||
	[[ ! "$PROJECTS" =~ ^[0-9]+$ || ! "$ROWS" =~ ^[0-9]+$ ]]; then
	fail "cannot classify local CarryCtx state"
fi
log "local state: db_exists=$([[ -e "$DB" || -L "$DB" ]] && echo 1 || echo 0) state=$STATE project_rows=$PROJECTS data_rows=$ROWS"

case "$STATE" in
absent | empty)
	;;
non-empty)
	if [[ "$DRY_RUN" == 0 && "$FORCE" == 0 ]]; then
		fail "local CarryCtx state is non-empty; refusing to overwrite without --force (local DB untouched)"
	fi
	;;
unknown)
	fail "local CarryCtx state is unknown; refusing to initialize or import"
	;;
*)
	fail "cannot classify local CarryCtx state"
	;;
esac

log "fetching $REMOTE $SNAP_BRANCH -> $TRACK_REF"
assert_stable_paths || fail "project paths changed before fetch"
assert_no_command_lock || fail "local CarryCtx operation is already in progress"
assert_probe_snapshot_unchanged || fail "local CarryCtx state changed before fetch"
if ! run_timed "$GIT_TIMEOUT" git -C "$PROJECT" fetch "$REMOTE" \
	"refs/heads/carryctx-snapshots:refs/remotes/$REMOTE/carryctx-snapshots"; then
	fail "git fetch failed (has refs/heads/carryctx-snapshots been published? network/auth?)"
fi
assert_stable_paths || fail "project paths changed during fetch"
assert_no_command_lock || fail "local CarryCtx operation started during fetch"
assert_probe_snapshot_unchanged || fail "local CarryCtx state changed during fetch"

print_provenance() {
	local commit export_id source_line message
	commit="$(run_timed "$GIT_TIMEOUT" git -C "$PROJECT" rev-parse --short "$TRACK_REF" 2>/dev/null || printf '?')"
	message="$(run_timed "$GIT_TIMEOUT" git -C "$PROJECT" log -1 --format=%B "$TRACK_REF" 2>/dev/null || true)"
	export_id="$(sed -n 's/^CarryCtx-Export-Id: //p' <<<"$message" | head -n1)"
	source_line="$(sed -n 's/^CarryCtx-Source: //p' <<<"$message" | head -n1)"
	log "provenance: snapshot=$commit export_id=${export_id:-?} source=${source_line:-?}"
}

if [[ "$DRY_RUN" == 1 ]]; then
	assert_stable_paths || fail "project paths changed before dry-run"
	assert_no_command_lock || fail "local CarryCtx operation is already in progress"
	assert_probe_snapshot_unchanged || fail "local CarryCtx state changed before dry-run"
	if ! run_dry_run_validation; then
		cat "$TMP_ROOT/dry-run.err" >&2 2>/dev/null || true
		fail "carryctx import --dry-run failed in isolated validation state; local DB untouched"
	fi
	assert_stable_paths || fail "project paths changed after dry-run"
	assert_no_command_lock || fail "local CarryCtx operation started during dry-run"
	assert_probe_snapshot_unchanged || fail "local CarryCtx state changed during dry-run"
	print_provenance
	if [[ "$STATE" == "non-empty" ]]; then
		log "dry-run PASS: snapshot fetched + validated in isolation; local DB is non-empty, a real run needs --force"
	else
		log "dry-run PASS: snapshot fetched + validated in isolation; local DB untouched"
	fi
	exit 0
fi

assert_stable_paths || fail "project paths changed before local backup"
assert_no_command_lock || fail "local CarryCtx operation is already in progress"
assert_probe_snapshot_unchanged || fail "local CarryCtx state changed before local backup"
if [[ -f "$CFG" ]]; then
	cp -p -- "$CFG" "$TMP_ROOT/config.toml.before" || fail "cannot back up $CFG"
	CFG_BACKUP="$TMP_ROOT/config.toml.before"
fi

# Fresh clone / no project row: initialize CarryCtx state explicitly so the
# documented fresh-clone path never depends on importer auto-init. The
# committed `.carryctx/config.toml` (when present) is restored byte-identically
# below, because `carryctx init` rewrites it with current config defaults.
if [[ "$STATE" == "absent" || "$STATE" == "empty" ]]; then
	assert_stable_paths || fail "project paths changed before initialization"
	assert_no_command_lock || fail "local CarryCtx operation is already in progress"
	assert_probe_snapshot_unchanged || fail "local CarryCtx state changed before initialization"
	log "local CarryCtx state is known-empty: initializing CarryCtx state (carryctx init --non-interactive)"
	if ! run_timed "$GIT_TIMEOUT" carryctx init --non-interactive --project "$PROJECT" >"$TMP_ROOT/init.log" 2>&1; then
		cat "$TMP_ROOT/init.log" >&2 2>/dev/null || true
		fail "carryctx init failed"
	fi
	assert_project_paths || fail "unsafe CarryCtx path after initialization"
	[[ -f "$DB" && ! -L "$DB" ]] || fail "CarryCtx initialization did not create a safe database"
	CARRYCTX_DIR_ID="$(capture_path_identity "$CARRYCTX_DIR")"
	CFG_ID="$(capture_path_identity "$CFG")"
	DB_ID="$(capture_path_identity "$DB")"
	DB_WAL_ID="$(capture_path_identity "$DB-wal")"
	DB_SHM_ID="$(capture_path_identity "$DB-shm")"
	probe_state "$DB" || fail "cannot inspect initialized CarryCtx state"
	read -r STATE PROJECTS ROWS <<<"$PROBE_RESULT" || fail "cannot classify initialized CarryCtx state"
	[[ "$STATE" == "non-empty" && "$PROJECTS" == "1" ]] || fail "CarryCtx initialization did not produce a project state"
fi

if [[ "$STATE" == "non-empty" ]]; then
	warn "--force: replacing existing local CarryCtx state in $PROJECT"
fi

assert_stable_paths || fail "project paths changed before import"
assert_no_command_lock || fail "local CarryCtx operation is already in progress"
assert_probe_snapshot_unchanged || fail "local CarryCtx state changed before import"
prepare_pre_import_boundary || fail "cannot create a verified pre-import boundary"
log "importing snapshot $TRACK_REF into isolated validation state"
if ! run_staging_import; then
	cat "$TMP_ROOT/staging-import.err" >&2 2>/dev/null || true
	fail "carryctx import failed in isolated state; target CarryCtx state was not modified"
fi
if ! reanchor_staging_project; then
	fail "isolated CarryCtx import could not be re-anchored to the target project"
fi
if ! validate_staging_import; then
	cat "$TMP_ROOT/staging-import.err" >&2 2>/dev/null || true
	fail "isolated CarryCtx import could not be verified; target CarryCtx state was not modified"
fi
commit_staged_import
assert_import_paths || fail "project paths changed during import; manual recovery required"

restore_config || exit 1

print_provenance
run_timed "$GIT_TIMEOUT" carryctx stats --project "$PROJECT" || fail "carryctx stats failed"
refresh_post_stats_paths || fail "active CarryCtx state changed during post-handoff statistics"
if ! validate_handoff_state; then
	fail "post-handoff committed-state validation failed; active state and recovery guard were preserved"
fi
log "restore complete; local counts:"

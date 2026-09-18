use bitty_devtools_client::protocol::chunk_text;
use bitty_devtools_client::transport::{
    Framer, IpcTransport, MAX_BUFFERED_BYTES, MAX_FRAME_BYTES, RC9_PAYLOAD_CAP_BYTES,
    RC10_CHUNK_CEILING, StdioTransportStub, TransportError, check_payload_cap, decode_frame,
    encode_frame,
};
use std::time::Instant;

const ORACLE_JSON: &str = include_str!("fixtures/fuzz/framer-seeds/vectors.json");

const LOCAL_TARGET_BUDGET_MS: u128 = 60_000;

fn seed_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("fuzz")
        .join("framer-seeds")
}

fn load_seed(name: &str) -> Vec<u8> {
    std::fs::read(seed_dir().join(name)).expect("seed file must exist")
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(hex: &str) -> Vec<u8> {
    assert!(hex.len() % 2 == 0, "hex must have even length");
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("valid hex"))
        .collect()
}

fn header_only(declared_len: u32) -> Vec<u8> {
    declared_len.to_be_bytes().to_vec()
}

fn expect_fail_closed_p0(bytes: &[u8], code: &str) {
    let mut framer = Framer::new();
    let result = framer.push_bytes(bytes);
    match code {
        "FrameTooLarge" => assert!(
            matches!(result, Err(TransportError::FrameTooLarge { .. })),
            "expected FrameTooLarge, got {result:?}"
        ),
        "PayloadTooLarge" => assert!(
            matches!(result, Err(TransportError::PayloadTooLarge { .. })),
            "expected PayloadTooLarge, got {result:?}"
        ),
        other => panic!("unknown oracle code {other}"),
    }
    assert!(framer.is_empty());
    assert_eq!(framer.buffered_len(), 0);
    let ok = framer.push_bytes(&encode_frame(b"ok").unwrap()).unwrap();
    assert_eq!(ok.len(), 1);
    assert_eq!(ok[0].payload(), b"ok");
}

fn oracle_has(id: &str) -> bool {
    ORACLE_JSON.contains(&format!("\"id\": \"{id}\""))
        || ORACLE_JSON.contains(&format!("\"id\":\"{id}\""))
}

fn request_json_of_len(total: usize) -> String {
    let head = "{\"id\":1,\"method\":\"bitty.debug/listPlugins\",\"params\":{\"pad\":\"";
    let tail = "\"},\"version\":\"1.0\"}";
    assert!(total > head.len() + tail.len());
    let pad = "a".repeat(total - head.len() - tail.len());
    let json = format!("{head}{pad}{tail}");
    assert_eq!(json.len(), total);
    json
}

fn connected_transport() -> IpcTransport {
    let mut transport = IpcTransport::with_defaults(
        1000,
        "/tmp/ctx-0074-fuzz-smoke-fixture.sock".to_owned(),
        None,
    );
    transport.connect().unwrap();
    transport
}

#[test]
fn oracle_manifest_version_and_shared_constants() {
    assert!(
        ORACLE_JSON.contains("\"manifestVersion\": 1")
            || ORACLE_JSON.contains("\"manifestVersion\":1")
    );
    assert_eq!(MAX_FRAME_BYTES, 262_144);
    assert_eq!(MAX_BUFFERED_BYTES, 262_152);
    assert_eq!(MAX_BUFFERED_BYTES + MAX_FRAME_BYTES, 524_296);
    assert_eq!(RC9_PAYLOAD_CAP_BYTES, 1_048_576);
    assert_eq!(RC10_CHUNK_CEILING, 262_144);
    for id in [
        "V01", "V02", "V03", "V04", "V05", "V06", "V07", "V08", "V09", "V10", "V11", "V12", "V13",
        "V14", "V15", "V16", "V17", "C01", "C02", "C03", "C04", "Q01", "Q02", "Q03", "Q04", "Q05",
    ] {
        assert!(oracle_has(id), "oracle must pin vector {id}");
    }
}

#[test]
fn seed_files_present_and_benign() {
    assert!(load_seed("empty.bin").is_empty());
    assert_eq!(load_seed("hello.bin"), b"hello");
    assert_eq!(to_hex(&load_seed("emoji.bin")), "f09f9880");
    assert_eq!(to_hex(&load_seed("cjk.bin")), "e697a5e69cace8aa9e");
    assert_eq!(to_hex(&load_seed("combining.bin")), "65cc81");
}

#[test]
fn t1_empty_push_emits_nothing() {
    let mut framer = Framer::new();
    assert!(framer.push_bytes(&[]).unwrap().is_empty());
    assert!(framer.is_empty());
}

#[test]
fn t1_zero_len_frame_decodes_to_empty_payload() {
    let mut framer = Framer::new();
    let frames = framer.push_bytes(&from_hex("00000000")).unwrap();
    assert_eq!(frames.len(), 1);
    assert!(frames[0].payload().is_empty());
    assert!(framer.is_empty());
}

#[test]
fn t1_header_splits_retain_then_decode() {
    for at in [1usize, 2, 3] {
        let wire = from_hex("0000000568656c6c6f");
        let mut framer = Framer::new();
        assert!(framer.push_bytes(&wire[..at]).unwrap().is_empty());
        assert_eq!(framer.buffered_len(), at);
        let frames = framer.push_bytes(&wire[at..]).unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].payload(), b"hello");
        assert!(framer.is_empty());
    }
}

#[test]
fn t1_trickle_emits_single_frame_at_end() {
    let wire = from_hex("000000026869");
    let mut framer = Framer::new();
    let mut emitted = 0usize;
    for (i, byte) in wire.iter().enumerate() {
        let frames = framer.push_bytes(std::slice::from_ref(byte)).unwrap();
        if i + 1 < wire.len() {
            assert!(frames.is_empty());
        } else {
            assert_eq!(frames.len(), 1);
            assert_eq!(frames[0].payload(), b"hi");
        }
        emitted += frames.len();
    }
    assert_eq!(emitted, 1);
    assert!(framer.is_empty());
}

#[test]
fn t1_coalesced_frames_decode_in_order() {
    let input = from_hex("000000016100000002626200000003636363");
    let mut framer = Framer::new();
    let frames = framer.push_bytes(&input).unwrap();
    assert_eq!(frames.len(), 3);
    assert_eq!(frames[0].payload(), b"a");
    assert_eq!(frames[1].payload(), b"bb");
    assert_eq!(frames[2].payload(), b"ccc");
    assert!(framer.is_empty());
}

#[test]
fn t1_truncated_header_and_body_short_recover() {
    let wire = from_hex("0000000568656c6c6f");
    let mut framer = Framer::new();
    assert!(framer.push_bytes(&wire[..2]).unwrap().is_empty());
    assert_eq!(framer.buffered_len(), 2);
    let frames = framer.push_bytes(&wire[2..]).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].payload(), b"hello");

    let long = from_hex("0000001068656c6c6f4141414141414141414141");
    let mut framer = Framer::new();
    assert!(framer.push_bytes(&long[..9]).unwrap().is_empty());
    assert_eq!(framer.buffered_len(), 9);
    assert!(framer.buffered_len() <= MAX_BUFFERED_BYTES + MAX_FRAME_BYTES);
    let frames = framer.push_bytes(&long[9..]).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].payload().len(), 16);
    assert_eq!(
        to_hex(frames[0].payload()),
        "68656c6c6f4141414141414141414141"
    );
}

#[test]
fn t1_oversize_declared_lengths_fail_closed() {
    expect_fail_closed_p0(&from_hex("00040001"), "FrameTooLarge");
    expect_fail_closed_p0(&from_hex("ffffffff"), "FrameTooLarge");
}

#[test]
fn t1_over_buffer_limit_plus_one_fail_closed() {
    let start = Instant::now();
    let input = vec![0u8; MAX_BUFFERED_BYTES + MAX_FRAME_BYTES + 1];
    assert_eq!(input.len(), 524_297);
    expect_fail_closed_p0(&input, "PayloadTooLarge");
    assert!(start.elapsed().as_millis() < LOCAL_TARGET_BUDGET_MS);
}

#[test]
fn t1_mixed_valid_then_oversize_recovers() {
    let input = from_hex("0000000568656c6c6fffffffff");
    let mut framer = Framer::new();
    let result = framer.push_bytes(&input);
    assert!(
        matches!(result, Err(TransportError::FrameTooLarge { .. })),
        "expected FrameTooLarge, got {result:?}"
    );
    assert!(framer.is_empty());
    assert_eq!(framer.buffered_len(), 0);
    let ok = framer.push_bytes(&encode_frame(b"ok").unwrap()).unwrap();
    assert_eq!(ok.len(), 1);
}

#[test]
fn t1_large_payloads_round_trip_in_memory() {
    let start = Instant::now();
    for len in [262_143usize, 262_144] {
        let payload = vec![65u8; len];
        let wire = encode_frame(&payload).unwrap();
        assert_eq!(wire.len(), 4 + len);
        let mut framer = Framer::new();
        let frames = framer.push_bytes(&wire).unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].payload(), payload.as_slice());
        assert!(framer.is_empty());
    }
    assert!(start.elapsed().as_millis() < LOCAL_TARGET_BUDGET_MS);
}

#[test]
fn t1_multibyte_body_splits_stay_byte_identical() {
    for (wire_hex, frame_hex, at) in [
        ("00000004f09f9880", "f09f9880", 6usize),
        ("00000009e697a5e69cace8aa9e", "e697a5e69cace8aa9e", 5usize),
    ] {
        let wire = from_hex(wire_hex);
        let mut framer = Framer::new();
        assert!(framer.push_bytes(&wire[..at]).unwrap().is_empty());
        let frames = framer.push_bytes(&wire[at..]).unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(to_hex(frames[0].payload()), frame_hex);
    }
    let emoji = load_seed("emoji.bin");
    let wire = encode_frame(&emoji).unwrap();
    let mut framer = Framer::new();
    assert!(framer.push_bytes(&wire[..6]).unwrap().is_empty());
    let frames = framer.push_bytes(&wire[6..]).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].payload(), emoji.as_slice());
}

#[test]
fn t1_rejected_input_leaves_queues_unchanged() {
    let stub = StdioTransportStub::new(64);
    let before_out = stub.outgoing_len();
    let mut framer = Framer::new();
    assert!(matches!(
        framer.push_bytes(&header_only(u32::MAX)),
        Err(TransportError::FrameTooLarge { .. })
    ));
    assert_eq!(stub.outgoing_len(), before_out);
    assert_eq!(stub.dropped_outgoing(), 0);
}

#[test]
fn t1_rejected_send_leaves_outgoing_unchanged() {
    let mut transport = connected_transport();
    assert_eq!(transport.outgoing_len(), 0);
    let oversized = request_json_of_len(1_048_577);
    assert!(transport.send_request(&oversized, 0).is_err());
    assert_eq!(transport.outgoing_len(), 0);
}

#[test]
fn t2_round_trip_single_shot_and_split() {
    let mut payloads: Vec<Vec<u8>> = vec![
        load_seed("empty.bin"),
        load_seed("hello.bin"),
        load_seed("emoji.bin"),
        load_seed("cjk.bin"),
        load_seed("combining.bin"),
        vec![65u8; 1024],
    ];
    assert_eq!(payloads.len(), 6);
    for payload in payloads.drain(..) {
        let wire = encode_frame(&payload).unwrap();
        let (frame, consumed) = decode_frame(&wire).unwrap();
        assert_eq!(consumed, 4 + payload.len());
        assert_eq!(frame.payload(), payload.as_slice());
        for at in [1usize, 3, 7] {
            if at >= wire.len() {
                continue;
            }
            let mut framer = Framer::new();
            assert!(framer.push_bytes(&wire[..at]).unwrap().is_empty());
            let frames = framer.push_bytes(&wire[at..]).unwrap();
            assert_eq!(frames.len(), 1);
            assert_eq!(frames[0].payload(), payload.as_slice());
        }
    }
    let hello_wire = encode_frame(&load_seed("hello.bin")).unwrap();
    assert_eq!(to_hex(&hello_wire), "0000000568656c6c6f");
    assert_eq!(to_hex(&encode_frame(&[]).unwrap()), "00000000");
}

#[test]
fn t3_chunk_boundary_parity_with_oracle() {
    assert_eq!(chunk_text("a😀b", 4).unwrap(), vec!["a", "😀", "b"]);
    assert_eq!(chunk_text("日本語", 4).unwrap(), vec!["日", "本", "語"]);
    assert_eq!(chunk_text("éx", 3).unwrap(), vec!["é", "x"]);
    for (text, limit, expected) in [
        ("a😀b", 4usize, vec!["a", "😀", "b"]),
        ("日本語", 4, vec!["日", "本", "語"]),
        ("éx", 3, vec!["é", "x"]),
    ] {
        let chunks = chunk_text(text, limit).unwrap();
        assert_eq!(chunks, expected);
        assert_eq!(chunks.concat(), text);
        for chunk in &chunks {
            assert!(chunk.len() <= limit);
        }
    }
    assert!(chunk_text("a😀b", 2).is_err());
}

#[test]
fn t4_chunk_counts_for_sized_requests() {
    let start = Instant::now();
    for (target, chunks) in [(262_144usize, 1), (262_145, 2), (1_048_576, 4)] {
        let json = request_json_of_len(target);
        let mut transport = connected_transport();
        transport.send_request(&json, 0).unwrap();
        assert_eq!(transport.outgoing_len(), chunks, "target {target}");
        let mut got = Vec::new();
        for _ in 0..chunks {
            let frame = transport.stub_mut().recv_outgoing().unwrap();
            assert!(frame.payload().len() <= MAX_FRAME_BYTES);
            got.extend_from_slice(frame.payload());
        }
        assert_eq!(got, json.as_bytes());
    }
    assert!(start.elapsed().as_millis() < LOCAL_TARGET_BUDGET_MS);
}

#[test]
fn t4_oversize_request_refused_with_payload_too_large() {
    let json = request_json_of_len(1_048_577);
    assert!(matches!(
        check_payload_cap(json.len()),
        Err(TransportError::PayloadTooLarge { .. })
    ));
    let mut transport = connected_transport();
    assert!(matches!(
        transport.send_request(&json, 0),
        Err(TransportError::PayloadTooLarge { .. })
    ));
}

fn inbound_on_data(
    inbound: &mut Framer,
    pending: &mut Vec<Vec<u8>>,
    framing_failed: &mut bool,
    data: &[u8],
) {
    if *framing_failed {
        return;
    }
    match inbound.push_bytes(data) {
        Ok(frames) => {
            for frame in &frames {
                pending.push(frame.payload().to_vec());
            }
        }
        Err(_) => {
            *framing_failed = true;
            inbound.clear();
            pending.clear();
        }
    }
}

#[test]
fn t4_inbound_failframing_model_drops_pending() {
    let mut inbound = Framer::new();
    let mut pending: Vec<Vec<u8>> = Vec::new();
    let mut framing_failed = false;
    inbound_on_data(
        &mut inbound,
        &mut pending,
        &mut framing_failed,
        &encode_frame(b"queued").unwrap(),
    );
    assert_eq!(pending.len(), 1);
    inbound_on_data(
        &mut inbound,
        &mut pending,
        &mut framing_failed,
        &from_hex("ffffffff"),
    );
    assert!(framing_failed);
    assert!(inbound.is_empty());
    assert!(pending.is_empty());
}

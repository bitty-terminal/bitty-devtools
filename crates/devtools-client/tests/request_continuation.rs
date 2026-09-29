//! Amendment A4 inbound request continuation encoder (bitty#1482).
//!
//! Mirrors the TypeScript `encodeRequestFrames` vectors so both clients emit
//! byte-identical fragments for the same request and continuation id.

use bitty_devtools_client::transport::{
    CONTINUATION_CHUNK_BYTES, CONTINUATION_FLAG_FINAL, CONTINUATION_HEADER_BYTES,
    CONTINUATION_MAGIC, MAX_FRAME_BYTES, RC9_PAYLOAD_CAP_BYTES, TransportError, decode_frame,
    encode_request_frames, next_continuation_id,
};

fn request_of(len: usize) -> Vec<u8> {
    (0..len).map(|i| b'a' + (i % 26) as u8).collect()
}

/// Validate every fragment header and return the reassembled request.
fn reassemble(frames: &[Vec<u8>], total: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(total);
    let mut id = None;
    for (sequence, wire) in frames.iter().enumerate() {
        let (frame, consumed) = decode_frame(wire).expect("valid frame");
        assert_eq!(consumed, wire.len());
        let payload = frame.payload();
        assert_eq!(payload[..4], CONTINUATION_MAGIC);
        let fragment_id = u32::from_be_bytes(payload[4..8].try_into().unwrap());
        assert_ne!(fragment_id, 0);
        assert_eq!(*id.get_or_insert(fragment_id), fragment_id);
        assert_eq!(
            usize::from(u16::from_be_bytes(payload[8..10].try_into().unwrap())),
            sequence
        );
        let last = sequence == frames.len() - 1;
        assert_eq!(payload[10], if last { CONTINUATION_FLAG_FINAL } else { 0 });
        assert_eq!(payload[11], 0);
        let declared = u32::from_be_bytes(payload[12..16].try_into().unwrap());
        assert_eq!(declared as usize, total);
        if !last {
            assert_eq!(
                payload.len(),
                MAX_FRAME_BYTES,
                "non-final fragments are full"
            );
        }
        out.extend_from_slice(&payload[CONTINUATION_HEADER_BYTES..]);
    }
    out
}

#[test]
fn a_request_that_fits_one_frame_stays_plain() {
    let request = request_of(MAX_FRAME_BYTES);
    let frames = encode_request_frames(&request, 0).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(&frames[0][4..], request.as_slice());
}

#[test]
fn just_above_one_frame_is_two_fragments() {
    let request = request_of(MAX_FRAME_BYTES + 1);
    let frames = encode_request_frames(&request, 5).unwrap();
    assert_eq!(frames.len(), 2);
    assert_eq!(reassemble(&frames, request.len()), request);
}

#[test]
fn the_inbound_limit_is_five_fragments() {
    let request = request_of(RC9_PAYLOAD_CAP_BYTES);
    let frames = encode_request_frames(&request, 5).unwrap();
    assert_eq!(frames.len(), 5);
    assert_eq!(reassemble(&frames, request.len()), request);
}

#[test]
fn an_exact_chunk_multiple_ends_with_a_full_final_fragment() {
    let request = request_of(CONTINUATION_CHUNK_BYTES * 2);
    let frames = encode_request_frames(&request, 5).unwrap();
    assert_eq!(frames.len(), 2);
    assert_eq!(reassemble(&frames, request.len()), request);
}

#[test]
fn the_header_layout_matches_the_typescript_vector() {
    let request = request_of(MAX_FRAME_BYTES + 1);
    let frames = encode_request_frames(&request, 0x0102_0304).unwrap();
    // magic, id, sequence 1, FINAL, reserved, total 262145 (0x00040001).
    assert_eq!(
        frames[1][4..4 + CONTINUATION_HEADER_BYTES],
        [
            0x00, 0x42, 0x43, 0x31, 0x01, 0x02, 0x03, 0x04, 0x00, 0x01, 0x01, 0x00, 0x00, 0x04,
            0x00, 0x01,
        ]
    );
}

#[test]
fn over_limit_and_zero_id_fail_without_frames() {
    let over = request_of(RC9_PAYLOAD_CAP_BYTES + 1);
    assert!(matches!(
        encode_request_frames(&over, 1),
        Err(TransportError::PayloadTooLarge { .. })
    ));
    let big = request_of(MAX_FRAME_BYTES + 1);
    assert!(matches!(
        encode_request_frames(&big, 0),
        Err(TransportError::InvalidFrame(_))
    ));
}

#[test]
fn continuation_ids_skip_zero_on_wrap() {
    assert_eq!(next_continuation_id(1), 2);
    assert_eq!(next_continuation_id(u32::MAX), 1);
}

#[test]
fn a_fragmented_request_is_queued_whole_or_not_at_all() {
    use bitty_devtools_client::transport::IpcTransport;
    // Capacity 2 with one slot taken: a two-fragment request must be
    // refused without enqueueing its first fragment (CodeRabbit on #149).
    let mut transport = IpcTransport::new(
        1000,
        "/tmp/ctx-0084-continuation-fixture.sock".to_owned(),
        None,
        0o700,
        0o600,
        1000,
        1000,
        2,
    );
    transport.connect().unwrap();
    transport.send_request(r#"{"id":1}"#, 0).unwrap();
    assert_eq!(transport.outgoing_len(), 1);
    let big = String::from_utf8(request_of(MAX_FRAME_BYTES + 1)).unwrap();
    assert!(matches!(
        transport.send_request(&big, 0),
        Err(TransportError::TransportFull { capacity: 2 })
    ));
    assert_eq!(transport.outgoing_len(), 1, "no partial reassembly queued");
}

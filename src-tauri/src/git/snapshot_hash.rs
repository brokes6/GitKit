//! Opaque review revisions need a digest, not a Git object. Hash incrementally
//! so an operation snapshot never buffers all dirty file contents in memory.
use sha2::{Digest, Sha256};
use std::io::{self, Write};

pub(super) struct SnapshotHasher(Sha256);

impl SnapshotHasher {
    pub(super) fn new() -> Self { Self(Sha256::new()) }

    pub(super) fn finish(self) -> String { format!("{:x}", self.0.finalize()) }
}

impl Write for SnapshotHasher {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn known_sha256_vector_is_independent_of_write_boundaries() {
        let mut whole = SnapshotHasher::new();
        whole.write_all(b"abc").unwrap();
        let mut pieces = SnapshotHasher::new();
        for piece in [b"a".as_slice(), b"".as_slice(), b"bc".as_slice()] {
            pieces.write_all(piece).unwrap();
        }
        let expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert_eq!(whole.finish(), expected);
        assert_eq!(pieces.finish(), expected);
        assert_eq!(SnapshotHasher::new().finish(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }

    #[test]
    fn large_generated_stream_matches_known_digest_across_chunks() {
        // The source generates 32 MiB without allocating a payload-sized Vec.
        // This digest is an independent SHA-256 vector for that complete stream.
        const LENGTH: u64 = 32 * 1024 * 1024;
        let mut copied = SnapshotHasher::new();
        let count = io::copy(&mut io::repeat(b'x').take(LENGTH), &mut copied).unwrap();
        assert_eq!(count, LENGTH);
        let mut chunked = SnapshotHasher::new();
        let chunk = [b'x'; 4093];
        let mut remaining = LENGTH as usize;
        while remaining > 0 {
            let size = remaining.min(chunk.len());
            chunked.write_all(&chunk[..size]).unwrap();
            remaining -= size;
        }
        let expected = "05f052c8f6da8ee5228ec291820b559c4be183773b9e97a6b82e30dacff85dd3";
        assert_eq!(copied.finish(), expected);
        assert_eq!(chunked.finish(), expected);
    }
}

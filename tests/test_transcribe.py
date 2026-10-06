import unittest
from pathlib import Path
import tempfile
import shutil
import sys
import os

# Add scripts directory to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from transcribe import format_timestamp, validate_audio_file

class TestTranscribeHelpers(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.data_dir = Path(self.temp_dir) / "data"
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_format_timestamp_srt(self):
        self.assertEqual(format_timestamp(0.0), "00:00:00,000")
        self.assertEqual(format_timestamp(1.5), "00:00:01,500")
        self.assertEqual(format_timestamp(65.123), "00:01:05,123")
        self.assertEqual(format_timestamp(3665.456), "01:01:05,456")

    def test_format_timestamp_vtt(self):
        self.assertEqual(format_timestamp(0.0, vtt=True), "00:00:00.000")
        self.assertEqual(format_timestamp(1.5, vtt=True), "00:01:01.500" if False else "00:00:01.500")
        self.assertEqual(format_timestamp(65.123, vtt=True), "00:01:05.123")
        self.assertEqual(format_timestamp(3665.456, vtt=True), "01:01:05.456")

    def test_validate_audio_file_valid(self):
        valid_wav = self.data_dir / "test.wav"
        valid_wav.write_bytes(b"RIFF dummy wav")
        
        result = validate_audio_file(str(valid_wav), self.data_dir)
        self.assertEqual(result, valid_wav.resolve())

    def test_validate_audio_file_outside_data_rejected(self):
        outside_file = Path(self.temp_dir) / "outside.wav"
        outside_file.write_bytes(b"RIFF dummy wav")

        with self.assertRaises(ValueError) as ctx:
            validate_audio_file(str(outside_file), self.data_dir)
        self.assertIn("Security restriction", str(ctx.exception))

    def test_validate_audio_file_unsupported_extension_rejected(self):
        invalid_ext = self.data_dir / "test.exe"
        invalid_ext.write_bytes(b"MZ dummy")

        with self.assertRaises(ValueError) as ctx:
            validate_audio_file(str(invalid_ext), self.data_dir)
        self.assertIn("Unsupported media format", str(ctx.exception))

    def test_validate_audio_file_nonexistent_rejected(self):
        nonexistent = self.data_dir / "nonexistent.wav"
        with self.assertRaises(ValueError) as ctx:
            validate_audio_file(str(nonexistent), self.data_dir)
        self.assertIn("does not exist", str(ctx.exception))

if __name__ == "__main__":
    unittest.main()

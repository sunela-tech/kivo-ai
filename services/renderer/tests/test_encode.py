import os
import shutil
import subprocess

import pytest

from kivo_renderer.encode import EncodeError, encode_mp4, make_thumbnail, probe, verify_mp4

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


@pytest.fixture()
def frames(tmp_path):
    out = tmp_path / "frames"
    out.mkdir()
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12", "-frames:v", "24",
         "-start_number", "1", str(out / "frame_%05d.png")],
        check=True,
    )
    return str(out)


def test_encodes_playable_h264(frames, tmp_path):
    video = str(tmp_path / "out.mp4")
    encode_mp4(frames, video, fps=12, width=320, height=180, frames=24, watermark=False)
    info = verify_mp4(video, width=320, height=180, frames=24, fps=12)
    assert info["codec"] == "h264" and info["pix_fmt"] == "yuv420p"
    assert abs(info["duration"] - 2.0) < 0.05
    with open(video, "rb") as fh:
        head = fh.read(4096)
    assert head[4:8] == b"ftyp"
    assert b"moov" in head, "moov atom must be at the front (faststart) so the video streams"


def test_watermark_changes_the_corner(frames, tmp_path):
    plain = str(tmp_path / "plain.mp4")
    marked = str(tmp_path / "marked.mp4")
    encode_mp4(frames, plain, fps=12, width=320, height=180, frames=24, watermark=False)
    encode_mp4(frames, marked, fps=12, width=320, height=180, frames=24, watermark=True)

    def corner(path):
        return subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path, "-vf", "crop=64:24:iw-70:ih-30", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
            check=True, capture_output=True,
        ).stdout

    assert corner(plain) != corner(marked)
    verify_mp4(marked, width=320, height=180, frames=24, fps=12)


def test_verification_catches_bad_output(frames, tmp_path):
    video = str(tmp_path / "out.mp4")
    encode_mp4(frames, video, fps=12, width=320, height=180, frames=24, watermark=False)
    with pytest.raises(EncodeError, match="frames decoded"):
        verify_mp4(video, width=320, height=180, frames=48, fps=12)
    with pytest.raises(EncodeError, match="size is"):
        verify_mp4(video, width=640, height=360, frames=24, fps=12)
    junk = tmp_path / "junk.mp4"
    junk.write_bytes(b"not a video" * 200)
    with pytest.raises(EncodeError):
        probe(str(junk))


def test_missing_frames_fail(tmp_path):
    with pytest.raises(EncodeError, match="frames are missing"):
        encode_mp4(str(tmp_path), str(tmp_path / "o.mp4"), fps=12, width=320, height=180, frames=10, watermark=False)


def test_thumbnail(frames, tmp_path):
    thumb = str(tmp_path / "t.jpg")
    make_thumbnail(frames, 24, thumb)
    assert os.path.getsize(thumb) > 500

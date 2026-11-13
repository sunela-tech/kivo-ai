"""The worker gives up early on renders that cannot meet their time limit."""
from kivo_renderer.worker import projected_overrun


def test_too_early_to_tell():
    # Only one frame interval measured, or too little time: no verdict yet.
    assert projected_overrun((0.0, 1), 92.0, 2, 2880, 21600.0) is None
    assert projected_overrun((0.0, 1), 5.0, 6, 2880, 21600.0) is None


def test_4k_two_minutes_on_a_cpu_worker_is_stopped_after_three_frames():
    # 92 s per frame, 2,880 frames, 6-hour limit: the job that prompted this check.
    message = projected_overrun((114.0, 1), 114.0 + 184.0, 3, 2880, 21600.0)
    assert message is not None
    assert "92 s per frame" in message
    assert "2877 of 2880 frames" in message
    assert "74 hours" in message and "6 hours" in message


def test_a_job_that_fits_is_left_alone():
    # 3.7 s per frame, 120 frames, 20-minute limit.
    assert projected_overrun((10.0, 1), 10.0 + 37.0, 11, 120, 1200.0) is None
    # Slightly behind schedule is tolerated: later shots are often lighter.
    assert projected_overrun((0.0, 1), 100.0, 11, 100, 100.0 + 700.0) is None


def test_a_clear_overrun_is_reported_even_late_in_the_job():
    message = projected_overrun((0.0, 1), 1000.0, 51, 200, 1000.0 + 600.0)
    assert message is not None and "149 of 200 frames" in message


def test_nothing_to_do_when_finished_or_past_the_deadline_with_no_frames_left():
    assert projected_overrun((0.0, 1), 500.0, 120, 120, 400.0) is None

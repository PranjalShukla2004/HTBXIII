import asyncio
import sys

import pytest

from app.console import capture_console


def test_console_keeps_terminal_output_and_captures_split_lines(capsys):
    frames = []
    original = sys.stdout
    with capture_console(frames.append):
        print("Click", end="")
        print('ed "Add to cart"')
        print("a browser warning", file=sys.stderr)
        print("partial", end="", flush=True)
    assert sys.stdout is original
    assert frames == [
        {"source": "stdout", "level": "info", "message": 'Clicked "Add to cart"', "partial": False},
        {"source": "stderr", "level": "error", "message": "a browser warning", "partial": False},
        {"source": "stdout", "level": "info", "message": "partial", "partial": True},
    ]
    terminal = capsys.readouterr()
    assert terminal.out == 'Clicked "Add to cart"\npartial'
    assert terminal.err == "a browser warning\n"


def test_overlapping_jobs_do_not_capture_each_other_or_unrelated_output(capsys):
    left, right = [], []
    original = sys.stdout

    async def scenario():
        left_started, right_started = asyncio.Event(), asyncio.Event()
        left_done = asyncio.Event()

        async def first():
            with capture_console(left.append):
                print("left")
                left_started.set()
                await right_started.wait()
            left_done.set()

        async def second():
            await left_started.wait()
            with capture_console(right.append):
                print("right")
                right_started.set()
                await left_done.wait()
                await asyncio.to_thread(print, "right worker")

        tasks = [asyncio.create_task(first()), asyncio.create_task(second())]
        await right_started.wait()
        print("unrelated server output")
        await asyncio.gather(*tasks)

    asyncio.run(scenario())
    assert [frame["message"] for frame in left] == ["left"]
    assert [frame["message"] for frame in right] == ["right", "right worker"]
    assert sys.stdout is original
    assert "unrelated server output" in capsys.readouterr().out


def test_console_flushes_unfinished_output_on_failure(capsys):
    frames = []
    with pytest.raises(RuntimeError):
        with capture_console(frames.append):
            print("unfinished", end="")
            raise RuntimeError("failed")
    assert frames[-1]["message"] == "unfinished"
    assert frames[-1]["partial"]
    assert capsys.readouterr().out == "unfinished"


def test_broken_console_observer_does_not_break_print(capsys):
    def broken(payload):
        raise RuntimeError("client disconnected")

    with capture_console(broken):
        print("still runs")
    assert capsys.readouterr().out == "still runs\n"

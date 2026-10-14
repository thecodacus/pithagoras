# Speech fixtures

`jfk.wav` is the sample bundled with
[Whisper.cpp](https://github.com/ggml-org/whisper.cpp/blob/master/samples/jfk.wav):
an excerpt from President John F. Kennedy's inaugural address. Browser tests
feed it into a synthetic MediaStream; they never use the physical microphone.

`smart-turn/jfk.json` is what Smart Turn's reference preprocessing and model make
of four pieces of it: a sample of the model's input features, their statistics,
and the probability that the turn is complete. `smart-turn/reference.py` writes
it; `tests/smart-turn.test.mts` compares the browser's own computation with it.

# Video fixtures

`clip.webm` and `clip.mp4` are one second of ffmpeg's `testsrc` pattern at 64 by 64
pixels (VP8 in a WebM, H.264 in an MP4 with its index at the front), a few
kilobytes each. The tests of video generation use them as the clips a server
answers with and as the files of a gallery; they were made with

    ffmpeg -f lavfi -i testsrc=size=64x64:rate=4 -t 1 -c:v libvpx -b:v 30k -an -f webm clip.webm
    ffmpeg -f lavfi -i testsrc=size=64x64:rate=4 -t 1 -c:v libx264 -pix_fmt yuv420p -movflags +faststart -an clip.mp4

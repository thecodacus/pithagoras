# Speech fixture

`jfk.wav` is the sample bundled with
[Whisper.cpp](https://github.com/ggml-org/whisper.cpp/blob/master/samples/jfk.wav):
an excerpt from President John F. Kennedy's inaugural address. Browser tests
feed it into a synthetic MediaStream; they never use the physical microphone.

# Video fixtures

`clip.webm` and `clip.mp4` are one second of ffmpeg's `testsrc` pattern at 64 by 64
pixels (VP8 in a WebM, H.264 in an MP4 with its index at the front), a few
kilobytes each. The tests of what a clip is read them, and Media's tests of
video generation (extensions/media/test) use them as the clips a server answers
with and as the files of a gallery; they were made with

    ffmpeg -f lavfi -i testsrc=size=64x64:rate=4 -t 1 -c:v libvpx -b:v 30k -an -f webm clip.webm
    ffmpeg -f lavfi -i testsrc=size=64x64:rate=4 -t 1 -c:v libx264 -pix_fmt yuv420p -movflags +faststart -an clip.mp4

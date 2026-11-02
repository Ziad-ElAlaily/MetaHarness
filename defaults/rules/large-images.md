---
when: start
description: look at large images through a smaller copy
---
Before you look at an image, check its size. Over about 1 MB or 1600 px, look at a smaller copy
instead (e.g. `magick in.png -resize 1280x1280\> /tmp/in-small.jpg`, or into the shared folder
for teammates). An image you've looked at goes with every later call to your model, and a big
one can make those calls fail.

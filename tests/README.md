Backend test (runs the plugin's Python against a throw-away home folder, no Steam needed):

    python3 -I tests/test_backend.py

It checks sorting and filters, albums, edited pictures in the index, and the send-to-phone web page (including that a wrong
link, an unknown picture and a path trick are refused).

# SAM2 LAN launcher

Use these launchers on any Windows computer in the same LAN as the SAM2 server.

## How to open SAM2

1. Copy this `lan_client` folder to the LAN computer.
2. Double-click `start_sam2_chrome.cmd` if Chrome is installed.
3. Double-click `start_sam2_edge.cmd` if Edge is installed.

The launcher opens:

```text
http://192.168.111.4:7262
```

It starts Chrome or Edge with a dedicated SAM2 browser profile and marks this LAN origin as secure for that browser session. This is required because the SAM2 demo uses WebCodecs APIs such as `VideoEncoder`, `VideoDecoder`, and `VideoFrame`.

## Important

- Open SAM2 with one of these launchers, not by typing the URL into a normal browser window.
- Keep using Chrome or Edge for this demo.
- If the page cannot load, first check that the computer can reach `http://192.168.111.4:7262/healthy`.

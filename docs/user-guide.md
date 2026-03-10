# User Guide

This guide explains how to log in, connect to an emulator, and use the controls.

## Login
1. Open the app in your browser.
2. Enter your username and password. (Default username: admin password:admin@1234)
3. Click Sign In.

If your admin deployed a custom domain, use the provided URL (http or https).

## Connect to an Emulator
1. Enter the emulator IP and port (ADB TCP).
2. Click Connect.
3. The stream starts automatically once connected.

If a device was connected previously, the last device is prefilled.

## Live Emulator View
- The emulator video appears on the right panel.
- A loading overlay appears until the stream is ready.
- A warning banner appears before session expiry.

## Controls
- Tap the video to click.
- Swipe to scroll or open the app drawer.
- Use buttons for BACK, HOME, RECENT, POWER, and KEYBOARD.
- Use the text input box to send text to the device.

## Tips
- If taps feel off, reload the page to refresh device resolution.
- Ensure the device is connected via ADB over TCP.
- The stream is optimized for low latency; do not open multiple sessions.

## Troubleshooting

- **No video:** check that the device is connected and streaming started.
- **Controls not responding:** verify the device is still connected.
- **Login failed:** confirm your user exists in `users.json`.
- **Session expired:** sign in again to continue.

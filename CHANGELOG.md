# Changelog

All notable changes to Table Tennis Vision. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/) (see [RELEASING.md](RELEASING.md)).

한국어: [CHANGELOG.ko.md](CHANGELOG.ko.md)

## [Unreleased]

## [1.0.0] - 2026-10-31

First tagged release: the app as it runs at the maintainer's club since the 0.1.0 snapshot, plus a new installer (`install.sh`, `deploy.env.example`) and a PC install guide.

### Added

- **Full-screen overlay in portrait too.** The camera picture fills the phone in both orientations, and the panels float on it: a one-row glance strip, see-through buttons, and a players / court map chip you can fold.
- **Each player's standing position** is drawn on the picture and on the court map.
- **Replay clips record the screen you see.** A rally's clip holds the camera picture with the overlay and the panels where they sit on screen (rally time, shots, speed, player panels, court map). Buttons, chips and the settings sheet stay out. Settings → replay overlay can turn it off and record the camera alone.
- **판정 안정 모드 (stable judging mode).** If the phone starts repeating frames (over 30% repeats) or reads fewer than 12 frames a second for two 5-second windows in a row, the picture shrinks so the analysis keeps up. It returns to full screen after 30 s of good reads. Settings has 자동 / 끄기 (auto / off), and tapping its chip goes back to full screen at once.
- **Low-light and small-table notices** when you confirm calibration, so you know before a match that tracking will be weak.
- **Ball colour setting:** white (default) or orange (experimental).
- **Calibration snap.** Roughly tapped corners snap onto the table's white border, and the outline is shown for you to confirm. If the snap is not clearly the table edge, your taps are kept. If a corner is on the frame edge, the app says the table end is off screen instead of calibrating.
- **Optional scoreboard link** (needs a compatible scoreboard app, see [docs/tournament-link.md](docs/tournament-link.md)):
  - Points are judged from the ball path and entered automatically, with a 3 s cancel bar. If the call is unsure, the app asks with one-tap buttons.
  - Korean score call-outs, ends that change by the table-tennis rules, and one-tap 렛?/폴트? (let? / fault?) prompts.
  - You can fix the score by hand on the camera screen while it keeps filming.
  - Red / blue are the table's two ends and stay put. Only the players move when ends change.
  - The camera writes points with the scoreboard PIN only. The PIN typed on the camera is remembered on that phone.
- **PC save by PIN.** Entering the scoreboard PIN in any browser turns on rally saving to your own PC. The upload key never leaves the PC. The first screen, the camera strip and settings show whether saving is on.
- The model loading bar counts the real bytes received (MB counter). A stalled or failed download says why and offers 다시 받기 (download again).

### Changed

- **A double tap no longer zooms the camera screen.** Two-finger pinch zoom still works.
- Every input field is at least 16 px on phones, so iOS Safari does not zoom in when you tap one. Options are spaced 8 px apart, and long lists fold.
- The players and court map panels start open on every visit.
- The back button works on every camera screen, and the browser back button does the same. While recording, it asks once before stopping the camera.
- Overlay labels (name plates, LOCK, speed, standing marks) are measured on screen so they never overlap each other, a button, or the 3 s cancel bar. Skeleton lines are drawn under the text.
- The settings sheet fits a 393 px phone.
- `PPV_TOURNAMENT_URL` has no built-in default. Without it, PIN save is off (503). `start.sh` reads it from `deploy.env` and stops with a message if it is missing (`off` turns it off).

### Fixed

- When the phone camera turns after it starts (landscape frames first, then portrait), the tap mapping, the analysis canvas and the clip recorder follow the new frame size.
- A ball flying over the table takes over from a fast blob next to it (a swinging arm).
- Ball lock for a camera low behind one end. The end-on cubic lock is off by default and can be turned on in settings.
- The bounce dip threshold scales with the table, not the frame height.
- A lone player at one end takes that end's slot, and is marked off screen only after 2 s.
- A reopened video file starts from 0 instead of the old end position.
- A changed scoreboard PIN cannot lock a camera out: an old PIN that is refused once is dropped.
- PIN save sends the scoreboard app only the client address this server saw (last hop from loopback, else the peer).

## [0.1.0] - 2026-10-29

First public snapshot (untagged, a single commit). On-device pose for two players, ball tracking, rally time and shots, estimated shot speed, bounce map, MOVE distance and wrist angle, LOCK marker, rally history, optional save to your own PC, offline accuracy harness on OpenTTGames.

[Unreleased]: https://github.com/orientpine/table-tennis-vision/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/orientpine/table-tennis-vision/releases/tag/v1.0.0
[0.1.0]: https://github.com/orientpine/table-tennis-vision/commit/56bb9e8

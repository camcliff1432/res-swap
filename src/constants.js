export const VIEW_W = 32, VIEW_H = 18;       // the screen, in tiles
export const MIN_W = 32, MIN_H = 18, MAX_W = 256, MAX_H = 144; // level size limits, in tiles
export const PX8 = 8;                       // 8-bit pixels per tile: picture is 256 x 144
export const LOW_SCALE = 8;                 // 8-bit pixels per low-res big pixel
export const PLAYER_W = 1, PLAYER_H = 1.5;
export const CLIMB_SPEED = 4;                // ladder and rope, tiles per second
export const RUN_SPEED = 6, GRAVITY = 30, JUMP_SPEED = 12, MAX_FALL = 20;
export const STEP = 1 / 60, MAX_STEPS_PER_FRAME = 5;
export const STEP_UP = 2 / PX8;             // rise the player and balls take without jumping
export const CRATE_SIZE = 2, DOOR_W = 2, DOOR_H = 3, BALL_SIZE = 1;
export const DETAIL_H = 0.25;               // height of spikes and button plates
export const PUSH_COOLDOWN = 0.15, CRATE_FALL_STEPS = 6;
export const BALL_SLOPE_ACCEL = 12, BALL_FRICTION = 4, BALL_MAX_SPEED = 14;
export const PORT = 8420;
export const SPRING_SPEED = 18;              // upward speed a spring gives, tiles per second
export const PLATFORM_SPEED = 2;             // moving platform, tiles per second
export const BLADE_SWING = 60, BLADE_PERIOD = 3; // swinging blade: degrees each side, seconds per swing
// Ice (slippery in 8-bit; ICE_IN_LOW makes it slippery in low-res too)
export const ICE_IN_LOW = false;
export const ICE_ACCEL = 8;                  // tiles/s^2: how fast the player's speed can change on ice
export const ICE_SLOPE_ACCEL = 12;           // tiles/s^2: downhill pull on an icy slope
// Crates in 8-bit are bodies (see objects.js stepCrates). Push speed, friction, and how fast a crate tilts to the slope.
export const CRATE_PUSH_SPEED = 3;           // tiles/s while the player pushes
export const EDGE_GLIDE_SPEED = 6;           // tiles/s: an 8-bit crate in front of a pushed low-res crate glides one tile at this speed
export const CRATE_FRICTION = 30;            // tiles/s^2 when not pushed and not on ice
export const CRATE_TILT_EASE = 5;            // degrees: most a crate turns in one step
export const CRATE_DRIFT = 4;                // tiles/s: a crate hanging off an edge by one side slides off at this speed

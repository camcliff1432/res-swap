// The block vote of the slider's middle steps: a block is kept when MORE than half of it is filled, so a tie goes: thin
// things vanish instead of swelling. The lowest step and ordinary low-res are not touched (world.js buildLow: ties kept).
export const wins = (count, total) => 2 * count > total;

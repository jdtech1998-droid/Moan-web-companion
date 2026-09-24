// Rider feedback buttons. The list index is the wire ID ("feedback-<index>"), so the order must stay identical
// to FEEDBACK_PRESETS in Howl-2.0.1's remoteplay/FeedbackPresets.kt.

export const FEEDBACK_PRESETS = [
  { label: 'Sensation', message: 'Feeling Signal', icon: '✨', badge: '#8FA8D9', background: '#20262F' },
  { label: 'Good', message: 'Keep going', icon: '👍', badge: '#C9BFF0', background: '#241F33' },
  { label: 'Beg', message: 'Begging for more!', icon: '🙏', badge: '#D98FC9', background: '#331F2C' },
  { label: 'Edge', message: 'Edge Me!', icon: '🔥', badge: '#CAA23A', background: '#2E2419' },
  { label: 'Cum', message: 'Make me Cum!', icon: '💦', badge: '#E08A3C', background: '#332318' },
  { label: 'Yield', message: 'Show me Mercy!', icon: '🏳️', badge: '#9C9AA5', background: '#26272B' },
  { label: 'Pause', message: 'PAUSE PLEASE!', icon: '⏸️', badge: '#5DB8B0', background: '#1C2B29' },
  { label: 'Torture', message: 'Post Orgasm Torture OK', icon: '😈', badge: '#7C5CBF', background: '#26203A' },
  { label: 'Cumming', message: "I'M CUMMING!", icon: '💥', badge: '#E0475F', background: '#331920' },
  { label: 'STOP', message: 'STOP! STOP! STOP!', icon: '🛑', badge: '#E24B4A', background: '#3A1F1F' },
];

/** Shown on the Driver when the Rider hits E-STOP. Not a feedback button, so it has no wire index. */
export const RIDER_ESTOP_PRESET = { label: 'E-STOP', message: 'RIDER E-STOP! Output stopped', icon: '🚨', badge: '#E5192F', background: '#4A1418' };

export const isStop = p => p.label === 'STOP' || p.label === 'E-STOP';

/** Words the Driver must not miss: never merged into a repeat counter, and pinned until acknowledged. */
export const isSafety = p => isStop(p) || p.label === 'Pause' || p.label === 'Yield';

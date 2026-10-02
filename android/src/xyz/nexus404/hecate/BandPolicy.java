package xyz.nexus404.hecate;

final class BandPolicy {
  static final long POLL = 5 * 60000L, HISTORY = 15 * 60000L, FILES = 60 * 60000L;

  static boolean due(long now, long last, long interval) {
    return last <= 0 || now < last || now - last >= interval;
  }

  static long retry(int failures) {
    return new long[] {10000, 30000, 60000, 120000, 300000, 900000}
        [Math.max(0, Math.min(5, failures - 1))];
  }

  static int player(int[] states, String[] packages, String last) {
    for (int i = 0; i < states.length; i++) if (states[i] == 3) return i;
    for (int i = 0; i < states.length; i++) if (states[i] == 6) return i;
    for (int i = 0; i < packages.length; i++) if (packages[i].equals(last)) return i;
    return states.length == 0 ? -1 : 0;
  }
}

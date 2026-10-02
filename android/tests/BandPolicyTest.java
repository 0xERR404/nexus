package xyz.nexus404.hecate;

public final class BandPolicyTest {
  static void ok(boolean b) {
    if (!b) throw new AssertionError();
  }

  public static void main(String[] args) {
    long now = 10000000;
    ok(BandPolicy.due(now, 0, BandPolicy.HISTORY));
    ok(BandPolicy.due(now, now + 1, BandPolicy.HISTORY));
    ok(!BandPolicy.due(now, now - 60000, BandPolicy.HISTORY));
    ok(BandPolicy.due(now, now - BandPolicy.HISTORY, BandPolicy.HISTORY));
    long time = 20 * 86400000L;
    ok(BandPolicy.historyFrom(time, time - 60000, false) == time - 31 * 60000L);
    ok(BandPolicy.historyFrom(time, time + 1, false) == time - 7 * 86400000L);
    ok(BandPolicy.historyFrom(time, 1, false) == time - 7 * 86400000L);
    ok(BandPolicy.historyFrom(time, time - 60000, true) == time - 7 * 86400000L);
    ok(BandPolicy.advanceHistory(true, true, false));
    ok(!BandPolicy.advanceHistory(true, false, false));
    ok(!BandPolicy.advanceHistory(true, true, true));
    ok(!BandPolicy.advanceHistory(false, true, false));
    long previous = 0;
    for (int i = 1; i < 50; i++) {
      long retry = BandPolicy.retry(i);
      ok(retry >= previous && retry <= 900000);
      previous = retry;
    }
    ok(BandPolicy.POLL == 300000 && BandPolicy.HISTORY == 900000 && BandPolicy.FILES == 3600000);
    ok(
        BandPolicy.player(new int[] {6, 3}, new String[] {"buffering", "playing"}, "buffering")
            == 1);
    ok(BandPolicy.player(new int[] {2, 3}, new String[] {"old", "playing"}, "old") == 1);
    ok(BandPolicy.player(new int[] {2, 2}, new String[] {"other", "last"}, "last") == 1);
    ok(BandPolicy.player(new int[] {6, 2}, new String[] {"buffering", "last"}, "last") == 0);
    ok(BandPolicy.player(new int[] {}, new String[] {}, "last") == -1);
    System.out.println("Band policy: clock rollback, cursors, bounded retry and polling OK");
  }
}

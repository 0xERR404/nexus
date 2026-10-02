package xyz.nexus404.hecate;

import java.nio.*;
import java.util.*;
import org.json.*;

public final class BandMetricsTest {
  static void ok(boolean v) {
    if (!v) throw new AssertionError();
  }

  static byte[] n(int v) {
    return new byte[] {(byte) (v >> 8), (byte) v};
  }

  public static void main(String[] args) throws Exception {
    long start = 1768003200000L;
    BandHistory h = new BandHistory("fixture", start, start + 86400000);
    h.metricsEnabled = true;
    JSONArray out = new JSONArray();
    h.activity(
        BandAuth.tlv(
            3,
            BandHistory.integer(start / 1000),
            132,
            BandAuth.tlv(5, new byte[] {0}, 6, new byte[] {12, 0, 12, 0, 80})),
        out);
    ok(out.length() == 1 && out.getJSONObject(0).getJSONObject("metrics").getInt("distance") == 80);
    Map<Long, Double> metrics = new HashMap<>();
    metrics.put(700013245L, 82d);
    metrics.put(700013878L, 47d);
    metrics.put(700013468L, 97.5);
    metrics.put(700013502L, 65535d);
    JSONObject sleep = BandDetails.sleepMetrics(metrics);
    ok(
        sleep.getInt("score") == 82
            && sleep.getDouble("oxygenAverage") == 97.5
            && !sleep.has("heartMax"));
    byte[] dictionary =
        BandAuth.tlv(
            129,
            BandAuth.tlv(
                130,
                BandAuth.tlv(
                    3,
                    BandHistory.integer(700013340),
                    4,
                    new byte[] {6},
                    5,
                    ByteBuffer.allocate(8).putDouble(96.5).array())));
    ok(BandDetails.summary(dictionary).get(700013340L) == 96.5);
    ByteBuffer header = ByteBuffer.allocate(14);
    header
        .putShort((short) 7)
        .putShort((short) 0)
        .putInt((int) (start / 1000))
        .put((byte) 1)
        .putShort((short) 2)
        .put((byte) 4)
        .putShort((short) 7);
    byte[] body =
        BandAuth.tlv(
            2, n(7), 3, n(0), 4, header.array(), 5, new byte[] {80, 0, 25, 70, 82, 0, 30, 72});
    Map<Integer, byte[]> fields = Collections.singletonMap(129, body);
    JSONObject page = BandWorkout.page(fields, h, 7, 0);
    ok(
        page.getJSONArray("samples").length() == 2
            && page.getJSONArray("samples").getJSONObject(0).getDouble("speed") == 2.5);
    try {
      BandWorkout.page(fields, h, 7, 1);
      throw new AssertionError("wrong page accepted");
    } catch (IllegalArgumentException expected) {
    }
    BandFiles f = new BandFiles(h, false, false, true);
    f.begin();
    f.accept(
        BandProtocol.parseTlv(
            BandAuth.tlv(129, BandAuth.tlv(2, new byte[] {23}, 4, new byte[] {1, 1, 1}))));
    f.accept(
        Collections.singletonMap(129, BandAuth.tlv(2, n(1), 133, BandAuth.tlv(6, n(7), 7, n(1)))));
    ok(
        f.accept(
                    Collections.singletonMap(
                        129,
                        BandAuth.tlv(
                            2,
                            n(7),
                            4,
                            BandHistory.integer(start / 1000),
                            5,
                            BandHistory.integer(start / 1000 + 600))))
                .command
            == 10);
    ok(f.accept(fields).service == 1);
    ok(f.records.length() == 2);
    System.out.println(
        "Band metrics: movement, decimal sleep fields, unavailable markers, workout capability and"
            + " page correlation OK");
  }
}

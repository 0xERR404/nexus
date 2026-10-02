package xyz.nexus404.hecate;

import java.util.*;
import org.json.*;

public class BandHistoryTest {
  static void ok(boolean b) {
    if (!b) throw new AssertionError();
  }

  static Map<Integer, byte[]> fields(byte[] a) {
    return Collections.singletonMap(129, a);
  }

  static byte[] n(int n) {
    return new byte[] {(byte) (n >> 8), (byte) n};
  }

  interface Action {
    void run() throws Exception;
  }

  static void bad(Action a) throws Exception {
    try {
      a.run();
      throw new AssertionError("malformed history accepted");
    } catch (IllegalArgumentException expected) {
    }
  }

  public static void main(String[] args) throws Exception {
    long start = 1768003200000L;
    BandHistory h = new BandHistory("fixture", start, start + 86400000L);
    JSONArray out = new JSONArray();
    ok(h.begin().command == 10);
    ok(h.accept(fields(BandAuth.tlv(2, n(1))), out).command == 11);
    byte[] minute = BandAuth.tlv(5, new byte[] {0}, 6, new byte[] {(byte) 0xc2, 1, 0, 42, 72, 98});
    byte[] body = BandAuth.tlv(2, n(0), 3, BandHistory.integer(start / 1000), 132, minute);
    ok(h.accept(fields(body), out).command == 12);
    ok(out.length() == 3);
    ok(out.getJSONObject(0).getInt("value") == 42);
    ok(out.getJSONObject(1).getJSONArray("samples").getJSONObject(0).getInt("bpm") == 72);
    ok(out.getJSONObject(2).getInt("value") == 98);
    JSONArray again = new JSONArray();
    h.activity(body, again);
    ok(again.toString().equals(out.toString()));
    byte[] missing =
        BandAuth.tlv(
            3,
            BandHistory.integer(start / 1000),
            132,
            BandAuth.tlv(
                5,
                new byte[] {0},
                6,
                new byte[] {(byte) 0xc2, 1, (byte) 255, (byte) 255, (byte) 255, 0}));
    JSONArray absent = new JSONArray();
    h.activity(missing, absent);
    ok(absent.length() == 0);
    bad(
        () ->
            h.activity(
                BandAuth.tlv(
                    3,
                    BandHistory.integer(start / 1000),
                    132,
                    BandAuth.tlv(5, new byte[] {0}, 6, new byte[] {0x42, 0, 1})),
                new JSONArray()));
    ok(h.accept(fields(BandAuth.tlv(2, n(1))), out).command == 13);
    byte[] sleepTime = new byte[6];
    System.arraycopy(BandHistory.integer(start / 1000), 0, sleepTime, 0, 4);
    sleepTime[5] = 30;
    byte[] sleep = BandAuth.tlv(2, n(0), 131, BandAuth.tlv(4, new byte[] {6}, 5, sleepTime));
    ok(h.accept(fields(sleep), out) == null && h.finished);
    JSONObject s = out.getJSONObject(3);
    ok(!s.getBoolean("complete") && s.getLong("end") - s.getLong("start") == 1800000);
    ok(s.getJSONArray("stages").getJSONObject(0).getInt("stage") == 4);
    BandHistory wrong = new BandHistory("x", start, start + 86400000L);
    wrong.begin();
    wrong.accept(fields(BandAuth.tlv(2, n(1))), new JSONArray());
    bad(() -> wrong.accept(fields(BandAuth.tlv(2, n(1))), new JSONArray()));
    BandHistory empty = new BandHistory("x", start, start + 86400000L);
    empty.begin();
    ok(empty.accept(fields(BandAuth.tlv(2, n(0))), new JSONArray()).command == 12);
    ok(empty.accept(fields(BandAuth.tlv(2, n(0))), new JSONArray()) == null);
    BandHistory limit = new BandHistory("x", start, start + 86400000L);
    limit.begin();
    bad(() -> limit.accept(fields(BandAuth.tlv(2, n(513))), new JSONArray()));
    out.put(h.record("band", start, start + 1).put("steps", 1271).put("battery", 48));
    if (args.length > 0)
      java.nio.file.Files.write(java.nio.file.Paths.get(args[0]), out.toString().getBytes("UTF-8"));
    System.out.println(
        "Band history: pagination, stable IDs, bitmaps, missing readings, sleep and bounds OK");
  }
}

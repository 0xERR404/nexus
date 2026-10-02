package xyz.nexus404.hecate;

import java.nio.*;
import java.util.*;
import org.json.*;

public class BandFilesTest {
  static void ok(boolean b) {
    if (!b) throw new AssertionError();
  }

  interface Action {
    void run() throws Exception;
  }

  static void bad(Action a) throws Exception {
    try {
      a.run();
      throw new AssertionError("invalid file accepted");
    } catch (IllegalArgumentException | java.security.GeneralSecurityException expected) {
    }
  }

  static Map<Integer, byte[]> tags(byte[] bytes) {
    return BandProtocol.parseTlv(bytes);
  }

  static byte[] caps(int service, byte... flags) {
    return BandAuth.tlv(129, BandAuth.tlv(2, new byte[] {(byte) service}, 4, flags));
  }

  static byte[] field(long id, long value) {
    return BandAuth.tlv(
        130,
        BandAuth.tlv(3, BandHistory.integer(id), 4, new byte[] {1}, 5, BandHistory.integer(value)));
  }

  static byte[] sleep(long start) {
    byte[] summary =
        BandAuth.tlv(129, BandAuth.concat(field(700013686, start), field(700013156, start + 180)));
    ByteBuffer b = ByteBuffer.allocate(64 + summary.length + 24);
    b.putInt(b.capacity()).putInt(700013).putShort((short) 1).putShort((short) 1);
    b.position(32);
    b.putInt((int) start)
        .putInt((int) (start + 180))
        .put((byte) 1)
        .put((byte) 2)
        .putShort((short) summary.length)
        .putInt(24);
    b.position(64);
    b.put(summary).order(ByteOrder.LITTLE_ENDIAN);
    for (int stage : new int[] {1, 2, 3}) b.putInt(60).put((byte) stage).put(new byte[3]);
    return b.array();
  }

  public static void main(String[] args) throws Exception {
    long start = 1768003200000L;
    BandHistory h = new BandHistory("fixture", start, start + 86400000L);
    byte[] sleep = sleep(start / 1000);
    JSONArray parsed = BandDetails.sleep(sleep, h, false);
    ok(parsed.length() == 1);
    JSONObject record = parsed.getJSONObject(0);
    ok(record.getJSONArray("stages").length() == 3);
    ok(record.getJSONArray("stages").getJSONObject(1).getInt("stage") == 6);
    ok(record.getBoolean("complete"));
    byte[] truncated = Arrays.copyOf(sleep, sleep.length - 1);
    bad(() -> BandDetails.sleep(truncated, h, false));
    byte[] overflow = sleep.clone();
    ByteBuffer.wrap(overflow).putInt(44, Integer.MAX_VALUE);
    bad(() -> BandDetails.sleep(overflow, h, false));
    ByteBuffer rri = ByteBuffer.allocate(114);
    rri.putLong(114).putShort((short) 0).putShort((short) 3);
    rri.position(48);
    rri.putInt((int) (start / 1000)).putInt((int) (start / 1000 + 60)).putInt(1).put((byte) 42);
    ok(BandDetails.stress(rri.array(), h).getJSONObject(0).getInt("value") == 42);
    byte[] wrongRri = rri.array().clone();
    wrongRri[11] = 4;
    bad(() -> BandDetails.stress(wrongRri, h));
    BandFiles f = new BandFiles(h, true, false, true);
    ok(f.begin().service == 1);
    ok(f.accept(tags(caps(0x17, (byte) 0, (byte) 0))).command == 3);
    ok(
        f.accept(tags(caps(0x2c, (byte) 1, (byte) 1, (byte) 1, (byte) 1, (byte) 1, (byte) 1)))
                .command
            == 0x31);
    ok(f.accept(tags(BandAuth.tlv(2, new byte[] {4}))).service == 0x2c);
    ok(
        f.accept(
                    tags(
                        BandAuth.tlv(
                            1,
                            BandAuth.utf("sequence_data"),
                            2,
                            new byte[] {0x16},
                            3,
                            new byte[] {9},
                            4,
                            BandHistory.integer(sleep.length))))
                .command
            == 2);
    ok(f.accept(tags(BandAuth.tlv(1, new byte[] {9}, 3, BandAuth.sha(sleep)))).command == 3);
    ok(
        f.accept(
                    tags(
                        BandAuth.tlv(
                            1, new byte[] {9}, 4, BandHistory.integer(1024), 5, new byte[] {0})))
                .command
            == 4);
    byte[] key = new byte[16],
        raw = BandAuth.concat(new byte[] {9}, BandHistory.integer(0), new byte[] {0}, sleep);
    bad(() -> f.data(raw, key));
    byte[] wrongOffset = raw.clone();
    wrongOffset[4] = 1;
    bad(() -> f.data(BandAuth.encrypted(key, wrongOffset), key));
    BandProtocol protocol = new BandProtocol(0x2c, 5);
    Map<Integer, byte[]> transport =
        protocol.accept(BandProtocol.frame(0x2c, 5, BandAuth.encrypted(key, raw)));
    ok(transport.containsKey(-1));
    ok(f.data(transport.get(-1), key).command == 6 && f.noReply());
    ok(f.records.length() == 1);
    ok(f.next().command == 1 && f.kind == 1);
    BandFiles corrupt = new BandFiles(h, true, false, false);
    corrupt.begin();
    corrupt.accept(tags(caps(0x17, (byte) 0, (byte) 0)));
    corrupt.accept(tags(caps(0x2c, (byte) 1, (byte) 1, (byte) 1, (byte) 1, (byte) 1, (byte) 1)));
    corrupt.accept(tags(BandAuth.tlv(2, new byte[] {0})));
    corrupt.accept(
        tags(
            BandAuth.tlv(
                1,
                BandAuth.utf("sequence_data"),
                2,
                new byte[] {0x16},
                3,
                new byte[] {9},
                4,
                BandHistory.integer(sleep.length))));
    corrupt.accept(tags(BandAuth.tlv(1, new byte[] {9}, 3, new byte[32])));
    corrupt.accept(
        tags(BandAuth.tlv(1, new byte[] {9}, 4, BandHistory.integer(1024), 5, new byte[] {1})));
    bad(() -> corrupt.data(raw, key));
    ok(corrupt.records.length() == 0);
    BandFiles workout = new BandFiles(h, false, false, true);
    workout.begin();
    ok(workout.accept(tags(caps(0x17, (byte) 1, (byte) 1))).command == 7);
    ok(
        workout.accept(
                    tags(
                        BandAuth.tlv(
                            129,
                            BandAuth.tlv(
                                2, new byte[] {0, 1}, 133, BandAuth.tlv(6, new byte[] {0, 7})))))
                .command
            == 8);
    workout.accept(
        tags(
            BandAuth.tlv(
                129,
                BandAuth.tlv(
                    2,
                    new byte[] {0, 7},
                    4,
                    BandHistory.integer(start / 1000),
                    5,
                    BandHistory.integer(start / 1000 + 600),
                    6,
                    BandHistory.integer(40),
                    7,
                    BandHistory.integer(1000)))));
    ok(workout.records.getJSONObject(0).getJSONObject("workout").getInt("distance") == 1000);
    BandFiles emptyWorkouts = new BandFiles(h, false, false, true);
    emptyWorkouts.begin();
    emptyWorkouts.accept(tags(caps(0x17, (byte) 1, (byte) 1)));
    ok(
        emptyWorkouts.accept(
                    tags(BandAuth.tlv(129, BandAuth.tlv(2, new byte[] {0, 0}, 133, new byte[0]))))
                .command
            == 3);
    ok(emptyWorkouts.records.length() == 0);
    BandFiles mismatch = new BandFiles(h, false, false, true);
    mismatch.begin();
    mismatch.accept(tags(caps(0x17, (byte) 1, (byte) 1)));
    bad(
        () ->
            mismatch.accept(
                tags(
                    BandAuth.tlv(
                        129,
                        BandAuth.tlv(
                            2, new byte[] {0, 2}, 133, BandAuth.tlv(6, new byte[] {0, 7}))))));
    ok(mismatch.records.length() == 0);
    ok(mismatch.fileBegin().service == 1);
    System.out.println(
        "Band files: capabilities, sleep stages, RRI, workouts, raw GATT, GCM, hash, offsets and"
            + " malformed lengths OK");
  }
}

package xyz.nexus404.hecate;

import java.nio.*;
import java.util.*;
import org.json.*;

public class BandFileRouteTest {
  static void ok(boolean b) { if (!b) throw new AssertionError(); }
  static Map<Integer, byte[]> tags(byte[] b) { return BandProtocol.parseTlv(b); }
  static BandFiles route(boolean dict, int flags) throws Exception {
    BandHistory h = new BandHistory("fixture", 1768003200000L, 1768089600000L);
    h.metricsEnabled = true;
    BandFiles f = new BandFiles(h, dict, false, true);
    f.fileBegin();
    ok(f.accept(tags(BandFilesTest.caps(0x2c, (byte)0, (byte)0, (byte)0, (byte)0, (byte)0, (byte)0))).command == 0x31);
    ok(f.capabilitiesReport.contains("1=0"));
    BandAuth.Request req = f.accept(tags(BandAuth.tlv(2, new byte[] {(byte)flags})));
    ok(req.service == (dict || (flags & 2) != 0 ? 0x2c : 0x0a));
    return f;
  }
  static BandFiles parameters(byte[] mode) throws Exception {
    BandFiles f = route(true, 6);
    byte[] bytes = BandFilesTest.sleep(1768003200L);
    f.accept(tags(BandAuth.tlv(1, BandAuth.utf("sequence_data"), 2, new byte[] {0x16},
        3, new byte[] {9}, 4, BandHistory.integer(bytes.length))));
    f.accept(tags(BandAuth.tlv(1, new byte[] {9}, 3, BandAuth.sha(bytes))));
    byte[] fields = BandAuth.tlv(1, new byte[] {9}, 4, BandHistory.integer(1024));
    if (mode != null) fields = BandAuth.concat(fields, BandAuth.tlv(5, mode));
    ok(f.accept(tags(fields)).command == 4);
    return f;
  }

  public static void main(String[] args) throws Exception {
    for (byte[] mode : new byte[][] {null, new byte[0], new byte[] {2}, new byte[] {0,1}, new byte[] {0}}) {
      BandFiles secure = parameters(mode);
      ok(!secure.rawRequest());
      byte[] raw = BandAuth.concat(new byte[] {9}, BandHistory.integer(0), new byte[] {0}, BandFilesTest.sleep(1768003200L));
      BandFilesTest.bad(() -> secure.data(raw, new byte[16]));
      ok(secure.data(BandAuth.encrypted(new byte[16], raw), new byte[16]).command == 6);
      ok(secure.records.length() == 1);
    }
    ok(parameters(new byte[] {1}).rawRequest());
    BandFiles stopped = parameters(new byte[] {2});
    BandAuth.Request reject = stopped.skipFile("неизвестный формат");
    ok(reject.service == 0x2c && reject.command == 6 && stopped.noReply());
    ok(BandProtocol.number(tags(reject.tlv), 2) == 2);
    ok(BandProtocol.number(tags(reject.tlv), 1) == 9 && stopped.records.length() == 0);
    ok(stopped.next().command == 1 && stopped.kind == 1);
    ok(stopped.skipFile("отказ 144001") == null && stopped.done);
    ok(stopped.status.contains("144001") && stopped.status.contains("неизвестный формат"));
    BandFiles f = route(false, 0);
    ok(f.legacy != null && f.filename().equals("sleep_state.bin"));
    BandAuth.Request init = f.legacy.begin();
    Map<Integer, byte[]> query = tags(init.tlv);
    ok(BandProtocol.number(query, 2) == 1 && query.containsKey(131));
    ok(f.accept(tags(BandAuth.tlv(1, BandAuth.utf("sleep_state.bin;sleep_data.bin")))).command == 2);
    ok(f.accept(tags(BandAuth.tlv(4, new byte[] {0, 16}))).command == 3);
    ok(f.accept(tags(BandAuth.tlv(2, BandHistory.integer(16)))).command == 4);
    byte[] state = ByteBuffer.allocate(16).order(ByteOrder.LITTLE_ENDIAN)
        .putInt(1768003200).putInt(1768027560).putLong(0).array();
    byte[] key = new byte[16];
    BandFilesTest.bad(() -> f.data(BandAuth.concat(new byte[] {0}, state), key));
    BandFilesTest.bad(() -> f.data(BandAuth.encrypted(key, BandAuth.concat(new byte[] {1}, state)), key));
    BandProtocol p = new BandProtocol(0x0a, 5);
    ok(p.accept(BandProtocol.frame(0x0a, 4, BandAuth.encrypted(key, BandAuth.tlv(127, BandHistory.integer(100000))))).containsKey(-2));
    Map<Integer, byte[]> frame = p.accept(BandProtocol.frame(0x0a, 5, BandAuth.encrypted(key, BandAuth.concat(new byte[] {0}, state))));
    ok(frame.containsKey(-1));
    ok(f.data(frame.get(-1), key).command == 6 && f.noReply());
    ok(f.records.length() == 1);
    JSONObject sleep = f.records.getJSONObject(0);
    ok((sleep.getLong("end") - sleep.getLong("start")) / 60000 == 406);
    ok(!sleep.getBoolean("complete") && sleep.getJSONArray("stages").getJSONObject(0).getInt("stage") == 2);
    BandAuth.Request stress = f.next();
    ok(stress.service == 0x0a && f.filename().equals("rrisqi_data.bin"));
    Map<Integer, byte[]> rri = tags(stress.tlv);
    ok(BandProtocol.number(rri, 2) == 4 && rri.containsKey(143));
    ok(f.accept(tags(BandAuth.tlv(1, BandAuth.utf("rrisqi_data.bin")))).command == 2);
    f.accept(tags(BandAuth.tlv(4, new byte[] {4, 0})));
    f.accept(tags(BandAuth.tlv(2, BandHistory.integer(114))));
    ByteBuffer value = ByteBuffer.allocate(114).putLong(114).putShort((short)0).putShort((short)3);
    value.position(48); value.putInt(1768003200).putInt(1768003260).putInt(1).put((byte)42);
    ok(f.data(BandAuth.encrypted(key, BandAuth.concat(new byte[] {0}, value.array())), key).command == 6);
    ok(f.records.getJSONObject(1).getInt("value") == 42);
    BandFiles noFile = route(false, 4);
    ok(noFile.accept(tags(BandAuth.tlv(1, new byte[0]))).service == 0x2c);
    ok(noFile.kind == 1);
    BandFiles dict = route(true, 0);
    ok(dict.legacy == null && dict.filename().equals("sequence_data"));
    ok(dict.next().service == 0x0a);
    BandFiles modern = route(false, 6);
    ok(modern.fileType() == 0x0e && modern.next().service == 0x2c);
    BandFilesTest.bad(() -> BandLegacyFile.sleepState(new byte[15], modern.history));
    byte[] invalid = state.clone(); Arrays.fill(invalid, 4, 8, (byte)0);
    BandFilesTest.bad(() -> BandLegacyFile.sleepState(invalid, modern.history));
    System.out.println("File routes: zero generic mask, authoritative flags, 0A sleep/RRI, framed encrypted packets, order, plain rejection, file absence and 2C routes OK");
  }
}

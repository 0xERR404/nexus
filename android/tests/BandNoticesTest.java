package xyz.nexus404.hecate;

import java.nio.charset.StandardCharsets;
import java.util.*;

public class BandNoticesTest {
  static void ok(boolean b) {
    if (!b) throw new AssertionError();
  }

  public static void main(String[] args) throws Exception {
    String longText = String.join("", Collections.nCopies(500, "Я😀"));
    String cut = BandNotices.trim(longText, 383);
    ok(cut.getBytes(StandardCharsets.UTF_8).length <= 383);
    ok(!Character.isHighSurrogate(cut.charAt(cut.length() - 1)));
    ok(BandNotices.trim(null, 20).isEmpty());
    byte[] packet = BandNotices.packet(65535, "org.example.app", longText, longText, 180);
    Map<Integer, byte[]> root = BandProtocol.parseTlv(packet);
    ok(Arrays.equals(root.get(1), new byte[] {-1, -1}));
    ok(BandProtocol.number(root, 2) == 127);
    byte[] list = BandProtocol.parseTlv(root.get(132)).get(140);
    List<byte[]> entries = BandProtocol.values(list, 141);
    ok(entries.size() == 2);
    for (byte[] e : entries) {
      Map<Integer, byte[]> item = BandProtocol.parseTlv(e);
      ok(BandProtocol.number(item, 15) == 2);
      ok(item.get(16).length <= 180);
    }
    byte[] encrypted = BandAuth.encrypted(new byte[32], packet);
    ok(BandProtocol.frame(2, 1, encrypted).length < 1022);
    ok(
        Arrays.equals(
            BandAuth.decrypted(new byte[32], BandProtocol.parseTlv(encrypted)).get(1),
            root.get(1)));
    Map<Integer, byte[]> limits =
        BandProtocol.parseTlv(
            BandAuth.tlv(
                129,
                BandAuth.tlv(
                    130,
                    BandAuth.tlv(
                        144,
                        BandAuth.tlv(
                            145, BandAuth.tlv(18, new byte[] {1}, 20, new byte[] {1, 0}))))));
    ok(BandNotices.contentLimit(limits) == 256);
    ok(BandNotices.contentLimit(Collections.emptyMap()) == 15);
    BandProtocol parser = new BandProtocol(7, 3);
    final int[] hits = {0};
    parser.unsolicited =
        (s, c, f) -> {
          ok(s == 0x25 && c == 3 && BandProtocol.number(f, 1) == 4);
          hits[0]++;
        };
    byte[] music = BandProtocol.frame(0x25, 3, new byte[] {1, 1, 4});
    ok(parser.accept(Arrays.copyOf(music, 5)) == null);
    ok(parser.accept(Arrays.copyOfRange(music, 5, music.length)) == null);
    ok(hits[0] == 1);
    ok(parser.accept(BandProtocol.frame(7, 3, new byte[] {1, 1, 9})) != null);
    System.out.println(
        "Band notices: Unicode limits, negotiated size, packet structure, encrypted frame bound and"
            + " interleaved music events OK");
  }
}

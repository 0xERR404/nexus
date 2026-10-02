package xyz.nexus404.hecate;

import java.util.*;

public class BandMonitorTest {
  static void ok(boolean b) { if (!b) throw new AssertionError(); }
  static Map<Integer, byte[]> caps(int a, int b, int c) {
    return BandProtocol.parseTlv(BandFilesTest.caps(7, (byte)a, (byte)b, (byte)c));
  }
  static final Map<Integer, byte[]> SUCCESS = BandProtocol.parseTlv(BandAuth.tlv(127, BandHistory.integer(100000)));
  static void command(BandAuth.Request r, int c, int value) {
    ok(r.service == 7 && r.command == c);
    ok(BandProtocol.number(BandProtocol.parseTlv(r.tlv),1) == value);
  }
  public static void main(String[] args) throws Exception {
    BandMonitor both = new BandMonitor(2,1,1);
    BandAuth.Request probe = both.begin();
    ok(probe.service == 1 && probe.command == 3);
    Map<Integer, byte[]> payload = BandProtocol.parseTlv(BandProtocol.parseTlv(probe.tlv).get(129));
    ok(Arrays.equals(payload.get(3), new byte[] {0x17,0x1c,0x24}));
    command(both.accept(caps(1,1,1)),0x1c,1);
    command(both.accept(SUCCESS),0x24,1);
    ok(both.accept(SUCCESS) == null);
    ok(both.report().contains("браслет подтвердил команду"));
    BandMonitor fallback = new BandMonitor(2,1,2);
    command(fallback.accept(caps(1,0,1)),0x17,1);
    command(fallback.failed("отказ 144001"),0x24,1);
    fallback.accept(Collections.emptyMap());
    ok(fallback.report().contains("144001") && fallback.report().contains("не подтверждено"));
    BandMonitor automatic = new BandMonitor(1,-1,3);
    command(automatic.accept(caps(1,1,1)),0x1c,0);
    command(automatic.accept(SUCCESS),0x17,1);
    ok(automatic.accept(SUCCESS) == null);
    BandMonitor off = new BandMonitor(0,0,4);
    command(off.accept(caps(1,1,1)),0x1c,0);
    command(off.accept(SUCCESS),0x17,0);
    command(off.accept(SUCCESS),0x24,0);
    ok(off.accept(SUCCESS) == null);
    BandMonitor unavailable = new BandMonitor(2,1,5);
    ok(unavailable.accept(caps(0,0,0)) == null);
    ok(!unavailable.report().contains("браслет подтвердил команду"));
    BandMonitor timeout = new BandMonitor(2,1,6);
    timeout.accept(caps(1,1,1));
    command(timeout.failed("тайм-аут"),0x24,1);
    ok(timeout.failed("тайм-аут") == null);
    BandMonitor probeFail = new BandMonitor(2,1,7);
    ok(probeFail.failed("нет ответа") == null);
    BandFilesTest.bad(() -> new BandMonitor(2,1,8).accept(caps(1,2,1)));
    BandMonitor refused = new BandMonitor(2,1,9); refused.accept(caps(1,1,1));
    try {
      refused.accept(BandProtocol.parseTlv(BandAuth.tlv(127, BandHistory.integer(100006))));
      throw new AssertionError("rejection accepted");
    } catch (BandAuth.RemoteError expected) { ok(!refused.report().contains("подтвердил")); }
    System.out.println("Monitoring: capability probe, realtime/auto/off, independent SpO2, acknowledgement, refusal and timeouts OK");
  }
}

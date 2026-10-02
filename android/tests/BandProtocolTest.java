package xyz.nexus404.hecate;

import java.util.*;

public class BandProtocolTest {
  static void ok(boolean b) {
    if (!b) throw new AssertionError();
  }

  static void bad(byte[] a) {
    try {
      new BandProtocol().accept(a);
      throw new AssertionError("accepted malformed data");
    } catch (IllegalArgumentException expected) {
    }
  }

  static byte[] slice(byte[] body, int kind, int seq) {
    byte[] a = new byte[body.length + 7];
    a[0] = 0x5a;
    int n = body.length + 2;
    a[1] = (byte) (n >> 8);
    a[2] = (byte) n;
    a[3] = (byte) kind;
    a[4] = (byte) seq;
    System.arraycopy(body, 0, a, 5, body.length);
    int c = BandProtocol.crc(a, a.length - 2);
    a[a.length - 2] = (byte) (c >> 8);
    a[a.length - 1] = (byte) c;
    return a;
  }

  public static void main(String[] args) {
    byte[] known = "123456789".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
    ok(BandProtocol.crc(known, known.length) == 0x31c3);
    byte[] a = BandProtocol.frame(new byte[] {1, 1, 2, 2, 2, 0, 20, 5, 4, 0, 3, 99, 98, 9, 1, 1});
    for (int split = 1; split < a.length; split++) {
      BandProtocol p = new BandProtocol();
      ok(p.accept(Arrays.copyOf(a, split)) == null);
      Map<Integer, byte[]> tags = p.accept(Arrays.copyOfRange(a, split, a.length));
      ok(tags.get(1)[0] == 2);
      String report = BandProtocol.report(tags);
      ok(report.contains("Версия авторизации: 3"));
      ok(!report.contains("99") && !report.contains("98"));
    }
    a[a.length - 1] ^= 1;
    bad(a);
    bad(new byte[] {0x5a, 127, 127});
    bad(BandProtocol.frame(new byte[] {1, 3, 0}));
    bad(BandProtocol.frame(new byte[] {1, 0, 1, 0}));
    bad(BandProtocol.frame(new byte[] {1, (byte) 128}));
    bad(new byte[4097]);
    byte[] identity =
        "0123456789ABCDEF0123456789ABCDEF".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
    byte[] request = BandProtocol.negotiation(identity);
    BandProtocol receiver = new BandProtocol(0x33);
    Map<Integer, byte[]> fields = null;
    for (int i = 0; i < request.length; i += 20)
      fields = receiver.accept(Arrays.copyOfRange(request, i, Math.min(request.length, i + 20)));
    ok(
        fields != null
            && BandProtocol.number(fields, 1) == 4
            && BandProtocol.number(fields, 2) == 1);
    ok(Arrays.equals(fields.get(5), identity));
    ok(new BandProtocol().accept(request) == null);
    byte[] reply = BandProtocol.frame(0x33, new byte[] {1, 1, 4, 2, 1, 1, 3, 4, 11, 22, 33, 44});
    Map<Integer, byte[]> result = new BandProtocol(0x33).accept(reply);
    String safe = BandProtocol.negotiationReport(result);
    ok(safe.contains("HiChain3"));
    ok(safe.contains("Размер challenge: 4"));
    ok(
        !safe.contains("11")
            && !safe.contains("22")
            && !safe.contains("33")
            && !safe.contains("44"));
    byte[] concat = new byte[BandProtocol.query().length + reply.length];
    System.arraycopy(BandProtocol.query(), 0, concat, 0, BandProtocol.query().length);
    System.arraycopy(reply, 0, concat, BandProtocol.query().length, reply.length);
    ok(new BandProtocol(0x33).accept(concat) != null);
    BandProtocol sliced = new BandProtocol(0x28);
    ok(sliced.accept(slice(new byte[] {1, 0x28, 1, 3, 7}, 1, 0)) == null);
    ok(sliced.accept(slice(new byte[] {8}, 2, 1)) == null);
    ok(Arrays.equals(sliced.accept(slice(new byte[] {9}, 3, 2)).get(1), new byte[] {7, 8, 9}));
    bad(slice(new byte[] {1, 1}, 3, 0));
    BandProtocol unordered = new BandProtocol();
    unordered.accept(slice(new byte[] {1, 1}, 1, 0));
    try {
      unordered.accept(slice(new byte[] {1, 0}, 3, 2));
      throw new AssertionError("Wrong sequence accepted");
    } catch (IllegalArgumentException expected) {
    }
    // A late asynchronous packet spans a command transition on the same GATT connection.
    BandProtocol persistent = new BandProtocol(1, 0x3e);
    byte[] async = BandProtocol.frame(1, 0x38, new byte[] {1, 1, 2});
    ok(persistent.accept(Arrays.copyOf(async, 5)) == null);
    persistent.expect(1, 0x35);
    byte[] ack = BandProtocol.frame(1, 0x35, new byte[] {127, 4, 0, 1, (byte) 0x86, (byte) 0xa0});
    byte[] tail = new byte[async.length - 5 + ack.length];
    System.arraycopy(async, 5, tail, 0, async.length - 5);
    System.arraycopy(ack, 0, tail, async.length - 5, ack.length);
    ok(persistent.accept(tail).containsKey(127));
    byte[] pair = new byte[ack.length * 2];
    System.arraycopy(ack, 0, pair, 0, ack.length);
    System.arraycopy(ack, 0, pair, ack.length, ack.length);
    ok(persistent.accept(pair) != null);
    ok(persistent.accept(new byte[0]) != null);
    ok(persistent.accept(new byte[0]) == null);
    persistent.expect(-1, -1);
    ok(persistent.accept(Arrays.copyOf(async, 4)) == null);
    persistent.expect(1, 0x35);
    ok(persistent.accept(Arrays.copyOfRange(async, 4, async.length)) == null);
    ok(persistent.accept(ack) != null);
    java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
    BandProtocol.field(out, 1, new byte[600]);
    ok(BandProtocol.parseTlv(out.toByteArray()).get(1).length == 600);
    ok(BandProtocol.query().length == 16);
    System.out.println("Band protocol: CRC, split frames, bounds, TLV, report redaction OK");
  }
}

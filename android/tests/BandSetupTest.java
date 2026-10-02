package xyz.nexus404.hecate;

import java.util.*;

public class BandSetupTest {
  static void ok(boolean b) {
    if (!b) throw new AssertionError();
  }

  static Map<Integer, byte[]> tags(byte[] a) {
    return BandProtocol.parseTlv(a);
  }

  static Map<Integer, byte[]> ack() {
    return tags(new byte[] {127, 4, 0, 1, (byte) 0x86, (byte) 0xa0});
  }

  static Map<Integer, byte[]> commands(int connect, int expand) {
    return tags(
        BandAuth.tlv(
            129, BandAuth.tlv(2, new byte[] {1}, 4, new byte[] {(byte) connect, (byte) expand})));
  }

  static Map<Integer, byte[]> account(int a, int b) {
    return tags(
        BandAuth.tlv(129, BandAuth.tlv(2, new byte[] {0x1a}, 4, new byte[] {(byte) a, (byte) b})));
  }

  static BandAuth.Request accept(BandSetup s, Map<Integer, byte[]> t) throws Exception {
    BandAuth.Request r = s.accept(t);
    if (s.optionalProbe()) r = s.accept(account(0, 0));
    return r;
  }

  static void timeReply(BandSetup s) throws Exception {
    BandAuth.Request r = s.begin();
    ok(r.command == 5);
    ok(accept(s, tags(BandAuth.tlv(1, BandProtocol.parseTlv(r.tlv).get(1)))).command == 3);
  }

  public static void main(String[] args) throws Exception {
    long now = 1768003200000L;
    Map<Integer, byte[]> t = tags(BandSetup.time(now, TimeZone.getTimeZone("GMT+05:30")));
    ok(BandHistory.uint(t.get(1), 4) == now / 1000);
    ok(Arrays.equals(t.get(2), new byte[] {5, 30}));
    ok(
        Arrays.equals(
            tags(BandSetup.time(now, TimeZone.getTimeZone("GMT-03:30"))).get(2),
            new byte[] {(byte) 131, (byte) -30}));
    BandSetup s = new BandSetup();
    timeReply(s);
    ok(accept(s, commands(1, 1)).command == 0x37);
    byte[] caps = new byte[14];
    caps[13] = 32;
    BandAuth.Request primary = accept(s, tags(BandAuth.tlv(1, caps)));
    ok(primary.command == 0x3e);
    Map<Integer, byte[]> p = tags(primary.tlv);
    ok(BandProtocol.number(p, 1) == 1 && BandProtocol.number(p, 3) == 0);
    ok(!s.waitsForReply());
    ok(s.sentWithoutReply().command == 0x35);
    ok(s.waitsForReply());
    ok(accept(s, ack()) == null);
    BandSetup none = new BandSetup();
    timeReply(none);
    try {
      none.sentWithoutReply();
      throw new AssertionError("Required reply skipped");
    } catch (IllegalStateException expected) {
    }
    ok(accept(none, commands(0, 0)) == null);
    BandSetup onlyMulti = new BandSetup();
    timeReply(onlyMulti);
    accept(onlyMulti, commands(0, 1));
    ok(accept(onlyMulti, tags(BandAuth.tlv(1, caps))).command == 0x3e);
    ok(onlyMulti.sentWithoutReply() == null);
    try {
      onlyMulti.sentWithoutReply();
      throw new AssertionError("Duplicate transition accepted");
    } catch (IllegalStateException expected) {
    }
    BandSetup noMulti = new BandSetup();
    timeReply(noMulti);
    accept(noMulti, commands(1, 1));
    ok(accept(noMulti, tags(BandAuth.tlv(1, new byte[14]))).command == 0x35);
    ok(accept(noMulti, ack()) == null);
    BandSetup bad = new BandSetup();
    timeReply(bad);
    try {
      accept(bad, tags(BandAuth.tlv(129, BandAuth.tlv(2, new byte[] {1}, 4, new byte[] {1}))));
      throw new AssertionError("Truncated capabilities accepted");
    } catch (IllegalArgumentException expected) {
    }
    BandSetup empty = new BandSetup();
    timeReply(empty);
    accept(empty, commands(1, 0));
    try {
      accept(empty, Collections.emptyMap());
      throw new AssertionError("Missing acknowledgement accepted");
    } catch (IllegalArgumentException expected) {
    }
    BandSetup accountSetup = new BandSetup();
    timeReply(accountSetup);
    accountSetup.accept(commands(1, 1));
    byte[] fullCaps = new byte[22];
    fullCaps[21] = 16;
    BandAuth.Request probe = accountSetup.accept(tags(BandAuth.tlv(1, fullCaps)));
    ok(probe.command == 3 && accountSetup.optionalProbe());
    BandAuth.Request noAccount = accountSetup.accept(account(1, 1));
    ok(noAccount.service == 0x1a && noAccount.command == 5);
    ok(
        BandProtocol.number(tags(noAccount.tlv), 1) == 0
            && BandProtocol.number(tags(noAccount.tlv), 3) == 1);
    ok(accountSetup.accept(ack()).command == 0x35);
    ok(accountSetup.accept(ack()) == null);
    for (boolean encryptedAck : new boolean[] {false, true}) {
      BandSetup emptyAccount = new BandSetup();
      timeReply(emptyAccount);
      emptyAccount.accept(commands(1, 0));
      emptyAccount.accept(account(1, 1));
      ok(emptyAccount.accountResponse());
      byte[] k = new byte[32];
      Map<Integer, byte[]> wireAck =
          encryptedAck ? tags(BandAuth.encrypted(k, new byte[0])) : Collections.emptyMap();
      ok(emptyAccount.accept(BandSetup.response(k, wireAck)).command == 0x35);
    }
    BandSetup refusedAccount = new BandSetup();
    timeReply(refusedAccount);
    refusedAccount.accept(commands(1, 0));
    refusedAccount.accept(account(1, 1));
    try {
      refusedAccount.accept(tags(new byte[] {127, 4, 0, 1, (byte) 0x86, (byte) 0xa5}));
      throw new AssertionError("Account rejection ignored");
    } catch (BandAuth.RemoteError expected) {
      ok(expected.code == 100005);
    }
    BandSetup unsupported = new BandSetup();
    timeReply(unsupported);
    unsupported.accept(commands(1, 0));
    ok(unsupported.optionalProbe());
    ok(unsupported.skipProbe().command == 0x35);
    byte[] key = new byte[32];
    Map<Integer, byte[]> plain = ack();
    ok(BandSetup.response(key, plain) == plain);
    Map<Integer, byte[]> encrypted =
        tags(BandAuth.encrypted(key, new byte[] {127, 4, 0, 1, (byte) 0x86, (byte) 0xa0}));
    ok(BandSetup.response(key, encrypted).containsKey(127));
    encrypted.get(126)[0] ^= 1;
    try {
      BandSetup.response(key, encrypted);
      throw new AssertionError("Invalid GCM fallback");
    } catch (javax.crypto.AEADBadTagException expected) {
    }
    try {
      BandSetup.response(key, tags(new byte[] {127, 4, 0, 0, 0, 1}));
      throw new AssertionError("Error acknowledged");
    } catch (java.security.GeneralSecurityException expected) {
    }
    System.out.println(
        "Band setup: time zones, capability gating, fire-and-forget setup, required"
            + " acknowledgements, malformed replies and GCM OK");
  }
}

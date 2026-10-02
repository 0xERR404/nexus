package xyz.nexus404.hecate;

import java.util.*;
import javax.crypto.*;
import javax.crypto.spec.*;
import org.json.*;

public final class BandAuthTest {
  static void ok(boolean value) {
    if (!value) throw new AssertionError();
  }

  static Map<Integer, byte[]> fields(BandAuth.Request r) {
    return BandProtocol.parseTlv(r.tlv);
  }

  static JSONObject payload(BandAuth.Request r) throws Exception {
    return new JSONObject(new String(fields(r).get(1), "UTF-8")).getJSONObject("payload");
  }

  static Map<Integer, byte[]> response(JSONObject p) throws Exception {
    return BandProtocol.parseTlv(
        BandAuth.tlv(
            1, BandAuth.utf(new JSONObject().put("payload", p).toString()), 4, new byte[] {0}));
  }

  static byte[] val(JSONObject p, String name) throws Exception {
    return BandAuth.unhex(p.getString(name));
  }

  static void reject(BandAuth a, Map<Integer, byte[]> p) throws Exception {
    try {
      a.accept(p);
      throw new AssertionError("Invalid proof accepted");
    } catch (java.security.GeneralSecurityException expected) {
    }
  }

  static BandAuth.Request exchange(
      BandAuth auth, BandAuth.Request r, byte[] root, byte[] peer, byte[] stable, boolean initial)
      throws Exception {
    JSONObject first = payload(r);
    byte[] identity = val(first, "peerAuthId"),
        salt = val(first, "isoSalt"),
        peerSalt = new byte[16];
    Arrays.fill(peerSalt, (byte) 7);
    byte[] psk = BandAuth.hmac(root, val(first, "seed"));
    JSONObject one =
        new JSONObject()
            .put("isoSalt", BandAuth.hex(peerSalt))
            .put("peerAuthId", BandAuth.hex(peer))
            .put(
                "token",
                BandAuth.hex(BandAuth.hmac(psk, BandAuth.concat(peerSalt, salt, identity, peer))));
    r = auth.accept(response(one));
    ok(
        java.security.MessageDigest.isEqual(
            val(payload(r), "token"),
            BandAuth.hmac(psk, BandAuth.concat(salt, peerSalt, peer, identity))));
    r =
        auth.accept(
            response(
                new JSONObject()
                    .put("returnCodeMac", BandAuth.hex(BandAuth.hmac(psk, new byte[4])))));
    byte[] session = BandAuth.hkdf(psk, BandAuth.concat(salt, peerSalt), "hichain_iso_session_key");
    if (initial) {
      JSONObject third = payload(r);
      byte[] challenge =
          BandAuth.gcm(
              false,
              session,
              val(third, "nonce"),
              val(third, "encData"),
              BandAuth.utf("hichain_iso_exchange"));
      byte[] iv = new byte[12];
      Arrays.fill(iv, (byte) 9);
      r =
          auth.accept(
              response(
                  new JSONObject()
                      .put("nonce", BandAuth.hex(iv))
                      .put(
                          "encAuthToken",
                          BandAuth.hex(BandAuth.gcm(true, session, iv, stable, challenge)))));
    }
    JSONObject finalEnvelope = new JSONObject(new String(fields(r).get(1), "UTF-8"));
    ok(finalEnvelope.getInt("message") == (initial ? 0x04 : 0x13));
    JSONObject fourth = payload(r);
    ok(
        Arrays.equals(
            new byte[4],
            BandAuth.gcm(
                false,
                session,
                val(fourth, "nonce"),
                val(fourth, "encResult"),
                BandAuth.utf("hichain_iso_result"))));
    BandAuth.Request next =
        auth.accept(BandProtocol.parseTlv(new byte[] {4, 1, (byte) (initial ? 1 : 2)}));
    if (!initial) {
      ok(next == null);
      ok(
          Arrays.equals(
              auth.sessionKey(),
              BandAuth.hkdf(session, BandAuth.concat(salt, peerSalt), "hichain_return_key")));
    }
    return next;
  }

  public static void main(String[] args) throws Exception {
    BandAuth.validateFinalNotice(BandProtocol.parseTlv(new byte[] {4, 1, 1}));
    BandAuth.validateFinalNotice(BandProtocol.parseTlv(new byte[] {4, 1, 2}));
    for (byte[] invalid : new byte[][] {new byte[0], {4, 1, 0}, {4, 2, 0, 1}}) {
      try {
        BandAuth.validateFinalNotice(BandProtocol.parseTlv(invalid));
        throw new AssertionError("Invalid finish accepted");
      } catch (java.security.GeneralSecurityException expected) {
      }
    }
    try {
      BandAuth.validateFinalNotice(
          BandProtocol.parseTlv(
              BandAuth.tlv(4, new byte[] {2}, 1, BandAuth.utf("{\"payload\":{\"errorCode\":5}}"))));
      throw new AssertionError("Error finish accepted");
    } catch (java.security.GeneralSecurityException expected) {
    }
    Map<Integer, byte[]> firstVariant = BandProtocol.parseTlv(new byte[] {1, 1, 4, 2, 1, 1}),
        reconnectVariant = BandProtocol.parseTlv(new byte[] {1, 1, 4, 2, 1, 2});
    BandAuth.validateNegotiation(firstVariant, false);
    BandAuth.validateNegotiation(firstVariant, true);
    BandAuth.validateNegotiation(reconnectVariant, true);
    try {
      BandAuth.validateNegotiation(reconnectVariant, false);
      throw new AssertionError("Reconnect without key accepted");
    } catch (java.security.GeneralSecurityException expected) {
    }
    try {
      BandAuth.validateNegotiation(BandProtocol.parseTlv(new byte[] {1, 1, 4, 2, 1, 3}), true);
      throw new AssertionError("Unknown variant accepted");
    } catch (java.security.GeneralSecurityException expected) {
    }
    // RFC 4231 HMAC-SHA256 test case 1 and RFC 5869 first expansion block.
    byte[] ikm = new byte[22];
    Arrays.fill(ikm, (byte) 11);
    byte[] salt = BandAuth.unhex("000102030405060708090A0B0C");
    byte[] prk = BandAuth.hmac(salt, ikm);
    ok(
        BandAuth.hex(prk)
            .equals("077709362C2E32DF0DDC3F0DC47BBA6390B6C73BB50F9C3122EC844AD7C2B3E5"));
    byte[] hkey = new byte[20];
    Arrays.fill(hkey, (byte) 11);
    ok(
        BandAuth.hex(BandAuth.hmac(hkey, BandAuth.utf("Hi There")))
            .equals("B0344C61D8DB38535CA8AFCEAF0BF12B881DC200C9833DA726E9376C2E32CFF7"));
    ok(
        BandAuth.hex(BandAuth.gcm(true, new byte[16], new byte[12], new byte[0], null))
            .equals("58E2FCCEFA7E3061367F1D57A4E7455A"));
    byte[] id = BandAuth.utf("0123456789ABCDEF0123456789ABCDEF"),
        pin = {12, 34, 56, 78},
        iv = new byte[16],
        peer = BandAuth.utf("test-band"),
        stable = new byte[32];
    Arrays.fill(stable, (byte) 5);
    final byte[][] stored = new byte[2][];
    BandAuth a =
        new BandAuth(
            id,
            null,
            null,
            0,
            (token, p) -> {
              stored[0] = token.clone();
              stored[1] = p.clone();
            });
    ok(a.start().command == 0x2c);
    Cipher c = Cipher.getInstance("AES/CBC/PKCS5Padding");
    c.init(
        Cipher.ENCRYPT_MODE,
        new SecretKeySpec(BandAuth.unhex("70FB6C24035FDB552F38898AEEDE3F69"), "AES"),
        new IvParameterSpec(iv));
    BandAuth.Request first =
        a.accept(BandProtocol.parseTlv(BandAuth.tlv(1, c.doFinal(pin), 2, iv)));
    ok(first.tlv.length + 8 <= 1022);
    BandAuth.Request reconnect =
        exchange(a, first, BandAuth.sha(BandAuth.utf(BandAuth.hex(pin))), peer, stable, true);
    ok(Arrays.equals(stored[0], stable));
    ok(Arrays.equals(stored[1], peer));
    exchange(a, reconnect, stable, peer, stable, false);
    Map<Integer, byte[]> encrypted =
        BandProtocol.parseTlv(BandAuth.encrypted(a.sessionKey(), new byte[] {1, 1, 65}));
    ok(BandProtocol.number(BandAuth.decrypted(a.sessionKey(), encrypted), 1) == 65);
    ok(
        BandProtocol.number(
                BandAuth.batteryResponse(
                    a.sessionKey(), BandProtocol.parseTlv(new byte[] {1, 1, 65})),
                1)
            == 65);
    ok(BandProtocol.number(BandAuth.batteryResponse(a.sessionKey(), encrypted), 1) == 65);
    try {
      BandAuth.batteryResponse(a.sessionKey(), BandProtocol.parseTlv(new byte[] {1, 1, 101}));
      throw new AssertionError("Invalid battery accepted");
    } catch (java.security.GeneralSecurityException expected) {
    }
    try {
      BandAuth.batteryResponse(
          a.sessionKey(), BandProtocol.parseTlv(new byte[] {1, 1, 65, 126, 0}));
      throw new AssertionError("Partial encrypted envelope accepted");
    } catch (java.security.GeneralSecurityException expected) {
    }
    byte[] counters =
        BandAuth.tlv(
            129,
            BandAuth.tlv(
                131,
                BandAuth.tlv(5, new byte[] {0, 0, 0, 100}),
                131,
                BandAuth.tlv(5, new byte[] {0, 0, 0, 25})));
    Map<Integer, byte[]> totals =
        BandAuth.decrypted(
            a.sessionKey(), BandProtocol.parseTlv(BandAuth.encrypted(a.sessionKey(), counters)));
    ok(BandProtocol.steps(totals) == 125);
    byte[] wire = BandProtocol.frame(7, 3, BandAuth.encrypted(a.sessionKey(), counters));
    ok(new BandProtocol(1, 3).accept(wire) == null);
    ok(
        BandProtocol.steps(BandAuth.decrypted(a.sessionKey(), new BandProtocol(7, 3).accept(wire)))
            == 125);
    try {
      BandProtocol.steps(BandProtocol.parseTlv(BandAuth.tlv(129, new byte[0])));
      throw new AssertionError("Missing steps became zero");
    } catch (IllegalArgumentException expected) {
    }
    try {
      BandAuth.checkResult(BandProtocol.parseTlv(new byte[] {127, 4, 0, 0, 0, 1}));
      throw new AssertionError("Error status ignored");
    } catch (java.security.GeneralSecurityException expected) {
    }
    BandAuth.checkResult(
        BandProtocol.parseTlv(
            BandAuth.tlv(127, java.nio.ByteBuffer.allocate(4).putInt(100000).array())));
    try {
      BandAuth.batteryResponse(
          a.sessionKey(),
          BandProtocol.parseTlv(
              BandAuth.tlv(127, java.nio.ByteBuffer.allocate(4).putInt(100004).array())));
      throw new AssertionError("Remote error ignored");
    } catch (BandAuth.RemoteError expected) {
      ok(expected.code == 100004);
    }
    try {
      BandAuth.checkResult(BandProtocol.parseTlv(new byte[] {127, 1, 1}));
      throw new AssertionError("Malformed status accepted");
    } catch (BandAuth.RemoteError wrong) {
      throw new AssertionError("Malformed status must not retry");
    } catch (java.security.GeneralSecurityException expected) {
    }
    encrypted.get(126)[0] ^= 1;
    try {
      BandAuth.decrypted(a.sessionKey(), encrypted);
      throw new AssertionError("GCM accepted tampering");
    } catch (javax.crypto.AEADBadTagException expected) {
    }
    try {
      BandAuth.decrypted(a.sessionKey(), BandProtocol.parseTlv(new byte[] {1, 1, 65}));
      throw new AssertionError("plaintext accepted");
    } catch (java.security.GeneralSecurityException expected) {
    }
    BandAuth restored =
        new BandAuth(
            id,
            stored[0],
            stored[1],
            0,
            (t, p) -> {
              throw new AssertionError("Reconnect rewrote key");
            });
    exchange(restored, restored.start(), stable, peer, stable, false);
    restored.destroy();
    final int[] renewSaved = {0};
    byte[] previous = stable.clone();
    BandAuth renewal =
        new BandAuth(
            id,
            previous,
            peer,
            0,
            (t, p) -> {
              renewSaved[0]++;
              ok(Arrays.equals(t, stable));
            });
    ok(renewal.start(true).command == 0x2c);
    ok(renewSaved[0] == 0 && Arrays.equals(previous, stable));
    BandAuth.Request renewFirst =
        renewal.accept(BandProtocol.parseTlv(BandAuth.tlv(1, c.doFinal(pin), 2, iv)));
    ok(payload(renewFirst).getInt("operationCode") == 1 && renewSaved[0] == 0);
    BandAuth.Request renewLogin =
        exchange(
            renewal, renewFirst, BandAuth.sha(BandAuth.utf(BandAuth.hex(pin))), peer, stable, true);
    ok(renewSaved[0] == 1);
    exchange(renewal, renewLogin, stable, peer, stable, false);
    renewal.destroy();
    BandAuth interrupted =
        new BandAuth(
            id,
            stable,
            peer,
            0,
            (t, p) -> {
              throw new AssertionError("Interrupted recovery changed key");
            });
    interrupted.start(true);
    interrupted.destroy();
    ok(Arrays.equals(previous, stable));
    a.destroy();
    try {
      a.sessionKey();
      throw new AssertionError("destroyed key accepted");
    } catch (java.security.GeneralSecurityException expected) {
    }
    BandAuth bad =
        new BandAuth(
            id,
            stable,
            peer,
            0,
            (t, p) -> {
              throw new AssertionError();
            });
    bad.start();
    reject(
        bad,
        response(
            new JSONObject()
                .put("isoSalt", BandAuth.hex(new byte[16]))
                .put("peerAuthId", BandAuth.hex(peer))
                .put("token", BandAuth.hex(new byte[32]))));
    System.out.println(
        "Band auth: crypto vectors, initial bind + reconnect, key persistence, proof rejection, GCM"
            + " and plaintext rejection OK");
  }
}

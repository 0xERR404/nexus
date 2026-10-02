package xyz.nexus404.hecate;

import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;
import javax.crypto.*;
import javax.crypto.spec.*;
import org.json.*;

final class BandAuth {
  interface Store {
    void save(byte[] token, byte[] peer) throws Exception;
  }

  static final String GROUP = "7B0BC0CBCE474F6C238D9661C63400B797B166EA7849B3A370FC73A9A236E989";
  private final byte[] identity;
  private final Store store;
  private final int pinMethod;
  private byte[] token, knownPeer, peer, salt, peerSalt, seed, psk, session, challenge;
  private int operation, step;
  private long requestId;
  private boolean failed;

  static final class Request {
    final int service, command;
    final byte[] tlv;
    final String status;

    Request(int c, byte[] t, String s) {
      this(1, c, t, s);
    }

    Request(int service, int c, byte[] t, String s) {
      this.service = service;
      command = c;
      tlv = t;
      status = s;
    }
  }

  BandAuth(byte[] identity, byte[] token, byte[] knownPeer, int pinMethod, Store store) {
    if (identity.length != 32 || pinMethod < 0 || pinMethod > 1)
      throw new IllegalArgumentException("Неподдержанные параметры авторизации");
    if (token != null
        && (token.length < 16
            || token.length > 64
            || knownPeer == null
            || knownPeer.length < 1
            || knownPeer.length > 128))
      throw new IllegalArgumentException("Повреждён сохранённый ключ браслета");
    this.identity = identity.clone();
    this.token = token == null ? null : token.clone();
    this.knownPeer = knownPeer == null ? null : knownPeer.clone();
    this.pinMethod = pinMethod;
    this.store = store;
  }

  static void validateNegotiation(Map<Integer, byte[]> fields, boolean hasKey)
      throws GeneralSecurityException {
    int mode = BandProtocol.number(fields, 1), variant = BandProtocol.number(fields, 2);
    if (mode != 4 || (variant != 1 && variant != 2))
      throw new GeneralSecurityException("Неподдержанный вариант HiChain; ключ не использован");
    if (variant == 2 && !hasKey)
      throw new GeneralSecurityException(
          "Браслет выбрал повторное подключение, но сохранённого ключа нет. Не сбрасывай браслет;"
              + " пришли отчёт.");
  }

  static void validateFinalNotice(Map<Integer, byte[]> fields) throws Exception {
    int type = BandProtocol.number(fields, 4);
    if (type <= 0) throw new GeneralSecurityException("Неожиданный финальный тип HiChain: " + type);
    byte[] data = fields.get(1);
    if (data != null && data.length > 0) {
      String text = new String(data, StandardCharsets.UTF_8).trim();
      if (text.startsWith("{")) {
        JSONObject root = new JSONObject(text);
        JSONObject payload = root.optJSONObject("payload");
        if (root.optInt("errorCode", 0) != 0
            || (payload != null && payload.optInt("errorCode", 0) != 0))
          throw new GeneralSecurityException("Браслет вернул ошибку завершения HiChain");
      }
    }
  }

  Request start() throws Exception {
    return start(false);
  }

  Request start(boolean renew) throws Exception {
    if (step != 0) throw new IllegalStateException();
    if (renew && token != null) {
      Arrays.fill(token, (byte) 0);
      token = null;
    }
    if (token != null) return begin(2);
    return new Request(
        0x2c,
        tlv(1, new byte[0]),
        "Запрос локального PIN · подтверди подключение на браслете, если появится запрос");
  }

  Request begin(int op) throws Exception {
    operation = op;
    step = 1;
    requestId = System.currentTimeMillis();
    seed = random(32);
    salt = random(16);
    peer = null;
    peerSalt = null;
    session = null;
    challenge = null;
    psk = null;
    return outgoing();
  }

  Request accept(Map<Integer, byte[]> fields) throws Exception {
    if (failed || step == 5) throw new IllegalStateException("Сеанс уже закрыт");
    try {
      return process(fields);
    } catch (Exception e) {
      failed = true;
      throw e;
    }
  }

  private Request process(Map<Integer, byte[]> fields) throws Exception {
    byte[] code = fields.get(127);
    if (code != null) {
      if (code.length != 4 || ByteBuffer.wrap(code).getInt() != 100000)
        throw new GeneralSecurityException("Браслет отклонил запрос авторизации");
    }
    if (step == 0) {
      byte[] cipher = required(fields, 1, 16, 256),
          iv = required(fields, 2, pinMethod == 1 ? 12 : 16, 16);
      byte[] pin;
      if (pinMethod == 1)
        pin = gcm(false, unhex("70FB6C24035FDB552F38898AEEDE3F69"), iv, cipher, null);
      else {
        Cipher c = Cipher.getInstance("AES/CBC/PKCS5Padding");
        c.init(
            Cipher.DECRYPT_MODE,
            new SecretKeySpec(unhex("70FB6C24035FDB552F38898AEEDE3F69"), "AES"),
            new IvParameterSpec(iv));
        pin = c.doFinal(cipher);
      }
      if (pin.length < 1 || pin.length > 64)
        throw new GeneralSecurityException("Некорректный PIN-ответ");
      token = sha(hex(pin).getBytes(StandardCharsets.UTF_8));
      Arrays.fill(pin, (byte) 0);
      return begin(1);
    }
    int type = BandProtocol.number(fields, 4);
    if (step == 4) {
      validateFinalNotice(fields);
      if (operation == 1) return begin(2);
      step = 5;
      return null;
    }
    if (type != 0) throw new GeneralSecurityException("Неожиданный тип ответа HiChain");
    String json = new String(required(fields, 1, 2, 8192), StandardCharsets.UTF_8);
    JSONObject envelope = new JSONObject(json);
    if (envelope.has("requestId")
        && !Long.toString(requestId).equals(envelope.getString("requestId")))
      throw new GeneralSecurityException("Ответ от другого запроса");
    JSONObject p = envelope.getJSONObject("payload");
    if (envelope.optInt("errorCode", 0) != 0 || p.optInt("errorCode", 0) != 0)
      throw new GeneralSecurityException(
          "HiChain отклонил авторизацию · код "
              + (p.optInt("errorCode", 0) != 0
                  ? p.optInt("errorCode")
                  : envelope.optInt("errorCode")));
    if (step == 1) {
      peer = hexField(p, "peerAuthId", 1, 128);
      peerSalt = hexField(p, "isoSalt", 16, 16);
      byte[] proof = hexField(p, "token", 32, 32);
      if (operation == 2 && !MessageDigest.isEqual(peer, knownPeer))
        throw new GeneralSecurityException("Идентификатор браслета изменился; ключ не использован");
      psk = hmac(token, seed);
      if (!MessageDigest.isEqual(proof, hmac(psk, concat(peerSalt, salt, identity, peer))))
        throw new GeneralSecurityException("Подпись браслета не прошла проверку");
      step = 2;
    } else if (step == 2) {
      if (!MessageDigest.isEqual(hexField(p, "returnCodeMac", 32, 32), hmac(psk, new byte[4])))
        throw new GeneralSecurityException("Подтверждение HiChain не прошло проверку");
      session = hkdf(psk, concat(salt, peerSalt), "hichain_iso_session_key");
      step = operation == 1 ? 3 : 4;
    } else if (step == 3) {
      byte[] next =
          gcm(
              false,
              session,
              hexField(p, "nonce", 12, 12),
              hexField(p, "encAuthToken", 32, 80),
              challenge);
      if (next.length < 16 || next.length > 64)
        throw new GeneralSecurityException("Неверная длина ключа браслета");
      store.save(next, peer);
      Arrays.fill(token, (byte) 0);
      token = next;
      knownPeer = peer.clone();
      step = 4;
    } else throw new GeneralSecurityException("Неожиданный этап HiChain");
    return outgoing();
  }

  private Request outgoing() throws Exception {
    JSONObject p =
        new JSONObject()
            .put(
                "version",
                new JSONObject().put("minVersion", "1.0.0").put("currentVersion", "2.0.16"));
    JSONObject outer =
        new JSONObject()
            .put("authForm", 0)
            .put("payload", p)
            .put("groupAndModuleVersion", "2.0.1")
            .put("message", operation == 2 ? (step == 4 ? 0x13 : step | 0x10) : step);
    if (operation == 1)
      outer
          .put("requestId", Long.toString(requestId))
          .put("groupId", GROUP)
          .put("groupName", "health_group_name")
          .put("groupOp", 2)
          .put("groupType", 256)
          .put("peerDeviceId", new String(identity, StandardCharsets.UTF_8))
          .put("connDeviceId", new String(identity, StandardCharsets.UTF_8))
          .put("appId", "com.huawei.health")
          .put("ownerName", "");
    if (step == 1) {
      p.put("isoSalt", hex(salt))
          .put("peerAuthId", hex(identity))
          .put("operationCode", operation)
          .put("seed", hex(seed))
          .put("peerUserType", 0);
      if (operation == 2) {
        p.put("pkgName", "com.huawei.devicegroupmanage")
            .put("serviceType", GROUP)
            .put("keyLength", 32);
        outer.put("isDeviceLevel", false);
      }
    } else if (step == 2) {
      p.put("peerAuthId", hex(identity))
          .put("token", hex(hmac(psk, concat(salt, peerSalt, peer, identity))));
      if (operation == 2) outer.put("isDeviceLevel", false);
    } else if (step == 3) {
      byte[] iv = random(12);
      challenge = random(16);
      p.put("nonce", hex(iv))
          .put("encData", hex(gcm(true, session, iv, challenge, utf("hichain_iso_exchange"))));
    } else if (step == 4) {
      byte[] iv = random(12);
      p.put("nonce", hex(iv))
          .put("encResult", hex(gcm(true, session, iv, new byte[4], utf("hichain_iso_result"))))
          .put("operationCode", operation);
    }
    return new Request(
        0x28,
        tlv(
            1,
            utf(outer.toString()),
            2,
            new byte[] {(byte) operation},
            3,
            ByteBuffer.allocate(8).putLong(requestId).array()),
        "HiChain · "
            + (operation == 1 ? "первое сопряжение" : "проверка сохранённого ключа")
            + " · этап "
            + step
            + "/4");
  }

  byte[] sessionKey() throws Exception {
    if (failed || step != 5) throw new GeneralSecurityException("Сеанс не подтверждён");
    return hkdf(session, concat(salt, peerSalt), "hichain_return_key");
  }

  void destroy() {
    failed = true;
    for (byte[] a :
        new byte[][] {token, knownPeer, peer, salt, peerSalt, seed, psk, session, challenge})
      if (a != null) Arrays.fill(a, (byte) 0);
  }

  static byte[] encrypted(byte[] key, byte[] plain) throws Exception {
    byte[] iv = random(16);
    return tlv(124, new byte[] {1}, 125, iv, 126, gcm(true, key, iv, plain, null));
  }

  static Map<Integer, byte[]> batteryResponse(byte[] key, Map<Integer, byte[]> fields)
      throws Exception {
    checkResult(fields);
    Map<Integer, byte[]> plain;
    if (fields.containsKey(125) || fields.containsKey(126) || BandProtocol.number(fields, 124) > 0)
      plain = decrypted(key, fields);
    else {
      if (fields.containsKey(124) && BandProtocol.number(fields, 124) != 0)
        throw new GeneralSecurityException("Некорректный признак шифрования");
      plain = fields;
    }
    checkResult(plain);
    int level = BandProtocol.number(plain, 1);
    if (level < 0 || level > 100) throw new GeneralSecurityException("Некорректный ответ заряда");
    return plain;
  }

  static final class RemoteError extends GeneralSecurityException {
    private static final long serialVersionUID = 1L;
    final long code;

    RemoteError(long code) {
      super("Браслет отклонил запрос · код " + code);
      this.code = code;
    }
  }

  static void checkResult(Map<Integer, byte[]> fields) throws GeneralSecurityException {
    byte[] code = fields.get(127);
    if (code == null) return;
    if (code.length != 4) throw new GeneralSecurityException("Неверная длина кода ответа браслета");
    long value = ByteBuffer.wrap(code).getInt() & 0xffffffffL;
    if (value != 100000) throw new RemoteError(value);
  }

  static Map<Integer, byte[]> decrypted(byte[] key, Map<Integer, byte[]> fields) throws Exception {
    if (BandProtocol.number(fields, 124) <= 0)
      throw new GeneralSecurityException("Ответ не зашифрован; ключ сеанса не подтверждён");
    return BandProtocol.parseTlv(decryptedBytes(key, fields));
  }

  static byte[] decryptedBytes(byte[] key, Map<Integer, byte[]> fields) throws Exception {
    if (BandProtocol.number(fields, 124) != 1)
      throw new GeneralSecurityException("Нет шифрования файла");
    return gcm(false, key, required(fields, 125, 12, 16), required(fields, 126, 16, 8192), null);
  }

  static byte[] required(Map<Integer, byte[]> fields, int tag, int min, int max)
      throws GeneralSecurityException {
    byte[] a = fields.get(tag);
    if (a == null || a.length < min || a.length > max)
      throw new GeneralSecurityException("Неверное поле протокола: " + tag);
    return a;
  }

  static byte[] hexField(JSONObject p, String n, int min, int max) throws Exception {
    String s = p.getString(n);
    if (s.length() < min * 2 || s.length() > max * 2)
      throw new GeneralSecurityException("Неверная длина поля " + n);
    return unhex(s);
  }

  static byte[] tlv(Object... args) {
    java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
    for (int i = 0; i < args.length; i += 2)
      BandProtocol.field(out, (Integer) args[i], (byte[]) args[i + 1]);
    return out.toByteArray();
  }

  static byte[] random(int n) {
    byte[] a = new byte[n];
    new SecureRandom().nextBytes(a);
    return a;
  }

  static byte[] utf(String s) {
    return s.getBytes(StandardCharsets.UTF_8);
  }

  static String hex(byte[] a) {
    StringBuilder s = new StringBuilder();
    char[] digits = "0123456789ABCDEF".toCharArray();
    for (byte b : a) s.append(digits[(b & 255) >> 4]).append(digits[b & 15]);
    return s.toString();
  }

  static byte[] unhex(String s) {
    if (s.length() % 2 != 0 || !s.matches("[0-9a-fA-F]*"))
      throw new IllegalArgumentException("Некорректный HEX");
    byte[] a = new byte[s.length() / 2];
    for (int i = 0; i < a.length; i++)
      a[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
    return a;
  }

  static byte[] concat(byte[]... arrays) {
    int n = 0;
    for (byte[] a : arrays) n += a.length;
    byte[] r = new byte[n];
    int p = 0;
    for (byte[] a : arrays) {
      System.arraycopy(a, 0, r, p, a.length);
      p += a.length;
    }
    return r;
  }

  static byte[] sha(byte[] a) throws Exception {
    return MessageDigest.getInstance("SHA-256").digest(a);
  }

  static byte[] hmac(byte[] key, byte[] value) throws Exception {
    Mac m = Mac.getInstance("HmacSHA256");
    m.init(new SecretKeySpec(key, "HmacSHA256"));
    return m.doFinal(value);
  }

  static byte[] hkdf(byte[] key, byte[] salt, String info) throws Exception {
    return hmac(hmac(salt, key), concat(utf(info), new byte[] {1}));
  }

  static byte[] gcm(boolean encrypt, byte[] key, byte[] iv, byte[] value, byte[] aad)
      throws Exception {
    Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
    c.init(
        encrypt ? Cipher.ENCRYPT_MODE : Cipher.DECRYPT_MODE,
        new SecretKeySpec(key, "AES"),
        new GCMParameterSpec(128, iv));
    if (aad != null) c.updateAAD(aad);
    return c.doFinal(value);
  }
}

package xyz.nexus404.hecate;

import java.util.*;

final class BandSetup {
  boolean dictSleep, bedTime;
  private int step;
  private boolean expand, connection, multi, accountChecked, accountOptimization;

  static byte[] time(long millis, TimeZone zone) {
    int offset = zone.getOffset(millis) / 1000;
    return BandAuth.tlv(
        1,
        BandHistory.integer(millis / 1000),
        2,
        new byte[] {
          (byte) (offset < 0 ? 128 + (-offset) / 3600 : offset / 3600), (byte) (offset / 60 % 60)
        });
  }

  BandAuth.Request begin() {
    step = 0;
    return new BandAuth.Request(
        5,
        time(System.currentTimeMillis(), TimeZone.getDefault()),
        "Настройка времени и часового пояса · 01/05");
  }

  BandAuth.Request accept(Map<Integer, byte[]> tags) throws Exception {
    BandAuth.checkResult(tags);
    if (step == 0) {
      if (!tags.containsKey(127) && !tags.containsKey(1))
        throw new IllegalArgumentException("Нет подтверждения настройки времени");
      if (tags.containsKey(1)) BandHistory.uint(tags.get(1), 4);
      step = 1;
      return new BandAuth.Request(
          3,
          BandAuth.tlv(129, BandAuth.tlv(2, new byte[] {1}, 3, new byte[] {0x35, 0x37})),
          "Проверка команд подключения · 01/03");
    }
    if (step == 1) {
      byte[] body = tags.get(129);
      if (body == null) throw new IllegalArgumentException("Нет списка команд");
      Map<Integer, byte[]> fields = BandProtocol.parseTlv(body);
      if (BandProtocol.number(fields, 2) != 1)
        throw new IllegalArgumentException("Неверный сервис команд");
      byte[] flags = fields.get(4);
      if (flags == null
          || flags.length != 2
          || (flags[0] != 0 && flags[0] != 1)
          || (flags[1] != 0 && flags[1] != 1))
        throw new IllegalArgumentException("Неверная маска команд");
      connection = flags[0] == 1;
      expand = flags[1] == 1;
      if (expand) {
        step = 2;
        return new BandAuth.Request(
            0x37, new byte[] {1, 0}, "Возможности настройки браслета · 01/37");
      }
      return next();
    }
    if (step == 2) {
      byte[] caps = tags.get(1);
      if (caps == null || caps.length > 512)
        throw new IllegalArgumentException("Нет возможностей браслета");
      dictSleep = caps.length > 17 && (caps[17] & 128) != 0;
      bedTime = caps.length > 24 && (caps[24] & 128) != 0;
      multi = caps.length > 13 && (caps[13] & 32) != 0;
      accountOptimization = caps.length > 21 && (caps[21] & 16) != 0;
      return next();
    }
    if (step == 20) {
      byte[] body = tags.get(129);
      if (body == null) throw new IllegalArgumentException("Нет возможностей режима без аккаунта");
      Map<Integer, byte[]> f = BandProtocol.parseTlv(body);
      byte[] flags = f.get(4);
      if (BandProtocol.number(f, 2) != 0x1a
          || flags == null
          || flags.length != 2
          || (flags[0] != 0 && flags[0] != 1)
          || (flags[1] != 0 && flags[1] != 1))
        throw new IllegalArgumentException("Неверная маска режима без аккаунта");
      accountChecked = true;
      if (flags[0] == 1 && flags[1] == 1) {
        step = 21;
        byte[] bodyNoAccount =
            accountOptimization
                ? BandAuth.tlv(1, new byte[] {0}, 3, new byte[] {1})
                : BandAuth.tlv(1, new byte[] {0});
        return new BandAuth.Request(
            0x1a, 5, bodyNoAccount, "Завершение настройки без Huawei-аккаунта · 1A/05");
      }
      step = 2;
      return next();
    }
    if (step == 21) {
      step = 2;
      return next();
    }
    if (step == 4) {
      if (!tags.containsKey(127))
        throw new IllegalArgumentException("Нет явного подтверждения настройки подключения");
      return next();
    }
    throw new IllegalStateException("Настройка уже завершена");
  }

  boolean accountResponse() {
    return step == 21;
  }

  boolean optionalProbe() {
    return step == 20;
  }

  BandAuth.Request skipProbe() {
    if (!optionalProbe()) throw new IllegalStateException();
    accountChecked = true;
    step = 2;
    return next();
  }

  boolean waitsForReply() {
    return step != 3;
  }

  BandAuth.Request sentWithoutReply() {
    if (step != 3) throw new IllegalStateException("Команда требует ответа");
    return next();
  }

  private BandAuth.Request next() {
    if (!accountChecked) {
      step = 20;
      return new BandAuth.Request(
          3,
          BandAuth.tlv(129, BandAuth.tlv(2, new byte[] {0x1a}, 3, new byte[] {5, 6})),
          "Проверка поддержки режима без аккаунта · 01/03 для 1A");
    }
    if (multi && step < 3) {
      step = 3;
      return new BandAuth.Request(
          0x3e,
          BandAuth.tlv(1, new byte[] {1}, 2, BandAuth.utf("HUAWEI Band 11"), 3, new byte[] {0}),
          "Основное устройство · 01/3E");
    }
    if (connection && step < 4) {
      step = 4;
      return new BandAuth.Request(0x35, new byte[] {1, 1, 1}, "Подтверждение подключения · 01/35");
    }
    step = 5;
    return null;
  }

  static Map<Integer, byte[]> response(byte[] key, Map<Integer, byte[]> tags) throws Exception {
    BandAuth.checkResult(tags);
    if (tags.containsKey(124) || tags.containsKey(125) || tags.containsKey(126))
      return BandAuth.decrypted(key, tags);
    return tags;
  }
}

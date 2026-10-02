package xyz.nexus404.hecate;

import java.util.*;

/** Explicit monitoring settings; a local write is never a device acknowledgement. */
final class BandMonitor {
  final int heart, oxygen;
  final long revision;
  final ArrayDeque<BandAuth.Request> pending = new ArrayDeque<>();
  final List<String> results = new ArrayList<>();
  BandAuth.Request current;
  boolean probing = true;

  BandMonitor(int heart, int oxygen, long revision) {
    if (heart < -1 || heart > 2 || oxygen < -1 || oxygen > 1)
      throw new IllegalArgumentException("Неверный режим мониторинга");
    this.heart = heart; this.oxygen = oxygen; this.revision = revision;
  }

  BandAuth.Request begin() {
    return new BandAuth.Request(1, 3, BandAuth.tlv(129,
        BandAuth.tlv(2, new byte[] {7}, 3, new byte[] {0x17, 0x1c, 0x24})),
        "Проверка команд мониторинга · 07/17, 07/1C, 07/24");
  }

  void add(int command, boolean on, String name) {
    pending.add(new BandAuth.Request(7, command, BandAuth.tlv(1, new byte[] {(byte)(on ? 1 : 0)}),
        name + " · " + (on ? "включить" : "выключить")));
  }

  BandAuth.Request accept(Map<Integer, byte[]> tags) throws Exception {
    BandAuth.checkResult(tags);
    if (probing) {
      boolean[] caps = BandFiles.capabilities(tags, 7, 3);
      probing = false;
      if (heart >= 0) {
        if (heart == 2 && caps[1]) add(0x1c, true, "Пульс в реальном времени");
        else if (caps[0]) {
          if (caps[1]) add(0x1c, false, "Пульс в реальном времени");
          add(0x17, heart != 0, "Автоматический пульс");
          if (heart == 2) results.add("Реальное время не поддержано ответом браслета; выбран автоматический пульс");
        } else if (heart == 0 && caps[1]) add(0x1c, false, "Пульс в реальном времени");
        else results.add("Пульс: нужная команда не подтверждена браслетом");
      }
      if (oxygen >= 0) {
        if (caps[2]) add(0x24, oxygen == 1, "Автоматический SpO₂");
        else results.add("SpO₂: команда не подтверждена браслетом");
      }
    } else {
      results.add(current.status + (tags.containsKey(127)
          ? " · браслет подтвердил команду" : " · ответ без кода успеха, применение не подтверждено"));
    }
    return next();
  }

  BandAuth.Request failed(String reason) {
    results.add((probing ? "Проверка мониторинга" : current.status) + " · " + reason);
    if (probing) pending.clear();
    probing = false;
    return next();
  }

  BandAuth.Request next() { current = pending.poll(); return current; }
  String report() { return String.join("\n", results); }
}

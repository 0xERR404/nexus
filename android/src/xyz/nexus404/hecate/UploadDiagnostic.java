package xyz.nexus404.hecate;

final class UploadDiagnostic {
  static int error(Exception e) {
    if (e instanceof java.net.UnknownHostException) return 1;
    if (e instanceof java.net.SocketTimeoutException) return 2;
    if (e instanceof javax.net.ssl.SSLException) return 3;
    if (e instanceof java.net.ConnectException) return 4;
    if (e instanceof org.json.JSONException) return 5;
    if (e instanceof java.io.IOException) return 6;
    if (e instanceof InterruptedException) return 7;
    return 8;
  }

  static String reason(int code) {
    switch (code) {
      case 0: return "ошибка не зафиксирована";
      case 1: return "адрес хаба не разрешён DNS";
      case 2: return "истекло время ожидания сети";
      case 3: return "ошибка защищённого соединения TLS";
      case 4: return "не удалось соединиться с хабом";
      case 5: return "неверный формат JSON";
      case 6: return "ошибка доставки или подтверждения; см. этап и HTTP";
      case 7: return "отправка прервана";
      default: return "внутренняя ошибка отправки";
    }
  }

  static String stage(int code) {
    switch (code) {
      case 1: return "чтение подключения";
      case 2: return "проверка приёмника хаба";
      case 3: return "чтение сохранённого пакета";
      case 4: return "передача пакета в хаб";
      case 5: return "проверка подтверждения пакета";
      case 6: return "очередь пуста";
      case 7: return "проход завершён; остались пакеты";
      default: return "ещё не запускалась";
    }
  }
}

package xyz.nexus404.hecate;

import android.content.*;
import android.widget.Toast;

final class AppDiagnostics {
  static String redact(String value) {
    return value.replaceAll("(?i)Bearer\\s+[^\\s]+", "Bearer [скрыто]")
        .replaceAll("(?i)(?:[0-9a-f]{2}:){5}[0-9a-f]{2}", "[адрес скрыт]")
        .replaceAll("[A-Za-z0-9_-]{43,}", "[идентификатор скрыт]");
  }
  static synchronized void event(Context c,String group,String message) {
    android.content.SharedPreferences p=Vault.prefs(c);
    String line=new java.text.SimpleDateFormat("dd.MM HH:mm:ss",java.util.Locale.ROOT).format(new java.util.Date())
        +" · "+group+" · "+redact(message)+"\n";
    String log=p.getString("appJournal","")+line;
    if(log.length()>20000)log=log.substring(log.indexOf('\n',log.length()-16000)+1);
    p.edit().putString("appJournal",log).apply();
  }
  static String report(Context c) {
    android.content.SharedPreferences p=Vault.prefs(c);
    StringBuilder out=new StringBuilder(BandEvidence.report(c));
    out.append("\n\nБАНК\nПриём: ").append(Vault.active(c)?"включён":"пауза")
        .append(" · канал: ").append(BankSms.enabled(c)?"SMS":"уведомления")
        .append("\nСлушатель Android: ").append(BankListener.connected()?"подключён":"не подключён")
        .append(" · разрешение SMS: ").append(c.checkSelfPermission(android.Manifest.permission.RECEIVE_SMS)==android.content.pm.PackageManager.PERMISSION_GRANTED?"есть":"нет")
        .append("\nУведомлений банка: ").append(p.getLong("bankEvents",0))
        .append(" · SMS: ").append(p.getLong("smsEvents",0))
        .append(" · пропущено: ").append(p.getLong("skipped",0))
        .append("\nОбработка: ").append(p.getString("capture","ещё нет"))
        .append("\nПоследняя доставка: ").append(BandEvidence.time(p.getLong("last",0)))
        .append("\n").append(p.getString("status","ещё нет"));
    try(Queue q=new Queue(c)) {out.append("\nОчередь: ").append(q.count("pending")).append(" · отклонено: ").append(q.count("blocked"));}
    catch(Exception e){out.append("\nОчередь недоступна");}
    out.append("\n\nДОСТАВКА БРАСЛЕТА\n").append(p.getString("bandUploadStatus","ещё нет"))
        .append("\n\nУВЕДОМЛЕНИЯ И ПЛЕЕР\n").append(p.getString(BandNotices.STATUS,"ещё нет"))
        .append("\n").append(p.getString("bandMediaStatus","ещё нет"))
        .append("\n\nСИГНАЛ ХАБА\n").append(p.getString("bandRemoteStatus","ещё нет"))
        .append("\n\nЖУРНАЛ ПРИЛОЖЕНИЯ (последние события)\n").append(p.getString("appJournal","ещё нет"))
        .append("\n\nBLUETOOTH\n").append(p.getString("bandReport","ещё нет"));
    return redact(out.toString());
  }
  static void copy(Context c) {
    ((ClipboardManager)c.getSystemService(Context.CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("Геката · все журналы",report(c)));
    Toast.makeText(c,"Все журналы скопированы",Toast.LENGTH_SHORT).show();
  }
}

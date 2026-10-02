package xyz.nexus404.hecate;

import android.content.Context;
import android.os.Handler;
import java.io.*;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

/** No polling or wakelock while idle. Android may suspend this connection in Doze. */
final class BandHub {
  interface Listener { void refresh(String id); }
  final Context context;
  final Handler main;
  final Listener listener;
  volatile boolean stopped;
  volatile HttpsURLConnection connection;
  final Thread thread;
  BandHub(Context c, Handler h, Listener l) {context=c.getApplicationContext();main=h;listener=l;thread=new Thread(this::run,"band-hub-signal");thread.start();}
  void status(String s) {
    if(stopped)return;
    if(!s.equals(Vault.prefs(context).getString("bandRemoteStatus",""))) {
      Vault.prefs(context).edit().putString("bandRemoteStatus",s).apply();
      AppDiagnostics.event(context,"Сигнал хаба",s);
    }
  }
  void run() {
    int failures=0;
    while(!stopped) {
      HttpsURLConnection current=null;
      try {
        JSONObject cfg=BandUpload.config(context);
        if(cfg==null)throw new IOException();
        URL url=new URL(cfg.getString("origin")+"/api/rhythm/sync");
        if(!"https".equals(url.getProtocol()))throw new IOException();
        current=(HttpsURLConnection)url.openConnection(); connection=current;
        current.setInstanceFollowRedirects(false);current.setConnectTimeout(10000);current.setReadTimeout(170000);
        current.setRequestMethod("POST");current.setDoOutput(true);
        current.setRequestProperty("Authorization","Bearer "+cfg.getString("token"));
        current.setRequestProperty("Content-Type","application/json");
        byte[] body="{\"type\":\"watch\"}".getBytes(StandardCharsets.UTF_8);
        current.setFixedLengthStreamingMode(body.length);
        if(stopped)break;
        try(OutputStream out=current.getOutputStream()){out.write(body);}
        int code=current.getResponseCode();
        if(code!=200 || current.getContentType()==null || !current.getContentType().startsWith("application/x-ndjson")) {
          failures=6;
          status(code==401?"Сигнал хаба: ключ отклонён":"Сигнал хаба недоступен · проверь версию и подключение");
          throw new IOException();
        }
        status("Сигнал хаба подключён"); failures=0;
        try(InputStream in=current.getInputStream()) {
          while(!stopped) {
            String line=readLine(in);
            if(line==null)break;
            JSONObject event=new JSONObject(line);
            String id=event.optString("id");
            if(event.optString("type").equals("refresh") && validId(id))
              main.post(()->{if(!stopped)listener.refresh(id);});
          }
        }
      } catch(Exception ignored) {
        if(failures<6)status("Сигнал хаба: нет связи · повтор автоматически");
      } finally {connection=null;if(current!=null)current.disconnect();}
      if(stopped)break;
      try {Thread.sleep(BandPolicy.retry(++failures));}catch(InterruptedException e){break;}
    }
  }
  static boolean validId(String id) {return id!=null && id.matches("[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}");}
  static String readLine(InputStream in) throws IOException {
    ByteArrayOutputStream out=new ByteArrayOutputStream();
    int ch;
    while((ch=in.read())!=-1) {
      if(ch=='\n')return out.toString("UTF-8");
      if(out.size()>=1024)throw new IOException("Слишком длинный сигнал");
      out.write(ch);
    }
    if(out.size()!=0)throw new IOException("Незавершённый сигнал");
    return null;
  }
  static void ack(Context c,String id,String state) {
    if(!validId(id))return;
    new Thread(()->{try {
      JSONObject cfg=BandUpload.config(c);
      if(cfg!=null)new HubHttp.Call().send(cfg,new JSONObject().put("type","refreshAck").put("id",id).put("state",state));
    }catch(Exception ignored){}},"band-refresh-ack").start();
  }
  void close() {
    stopped=true;thread.interrupt();HttpsURLConnection current=connection;
    if(current!=null)new Thread(current::disconnect,"band-hub-close").start();
  }
}

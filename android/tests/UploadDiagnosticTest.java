package xyz.nexus404.hecate;

public final class UploadDiagnosticTest {
  public static void main(String[] args) throws Exception {
    Exception[] errors = {
      new java.net.UnknownHostException("secret.example/token"),
      new java.net.SocketTimeoutException("secret.example/token"),
      new javax.net.ssl.SSLException("secret.example/token"),
      new java.net.ConnectException("secret.example/token"),
      new org.json.JSONException("secret.example/token"),
      new java.io.IOException("secret.example/token"),
      new InterruptedException("secret.example/token"),
      new SecurityException("secret.example/token")
    };
    for (int i = 0; i < errors.length; i++) {
      int code = UploadDiagnostic.error(errors[i]);
      if (code != i + 1 || UploadDiagnostic.reason(code).contains("secret"))
        throw new AssertionError("Error classification or redaction");
    }
    if (!UploadDiagnostic.stage(5).contains("подтверждения")) throw new AssertionError();
    if (UploadDiagnostic.stage(999).contains("999")) throw new AssertionError();
    System.out.println("Upload diagnostics: network classification and private message redaction OK");
  }
}

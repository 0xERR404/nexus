package xyz.nexus404.hecate;

import java.math.BigDecimal;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class Expense {
  static final Pattern SECRET =
      Pattern.compile(
          "одноразов|парол|подтвер[дж]|авторизац|вход|verification|password|\\botp\\b|\\bcode\\b|код[\\s:]",
          Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
  static final Pattern OTHER =
      Pattern.compile(
          "возврат|зачислен|поступлен|отмен|отклон|недостаточ|перевод|refund|declined|transfer",
          Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
  static final Pattern AMOUNT =
      Pattern.compile(
          "(?:покупка|оплата|списание|списано|purchase|payment)\\s*[:—-]?\\s*((?:\\d{1,3}(?: \\d{3})+|\\d{1,10})(?:[.,]\\d{1,2})?)\\s*(₽|руб\\.?|RUB|USD|EUR|\\$|€)(?=\\s|[.,;!]|$)",
          Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
  static final Pattern SBER =
      Pattern.compile(
          "\\AПриятные траты в [^\\r\\n]+\\r?\\n[ \\t]*((?:\\d{1,3}(?: \\d{3})+|\\d{1,10})(?:[.,]\\d{1,2})?)[ \\t]*(₽|руб\\.?|RUB)[ \\t]*[—–-][ \\t]*В запасе:",
          Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
  static final Pattern STANDARD =
      Pattern.compile(
          "\\AПокупка[ \\t]+([\\s\\S]{1,160}?)\\r?\\n[ \\t]*((?:\\d{1,3}(?: \\d{3})+|\\d{1,10})(?:[.,]\\d{1,2})?)[ \\t]*(₽|руб\\.?|RUB)[ \\t]*[—–-][ \\t]*Баланс:",
          Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
  final long amount;
  final String currency, merchant, kind;

  Expense(long amount, String currency, String merchant) {
    this(amount, currency, merchant, "expense");
  }

  Expense(long amount, String currency, String merchant, String kind) {
    this.amount = amount;
    this.currency = currency;
    this.merchant = merchant;
    this.kind = kind;
  }

  static boolean allowedSender(String sender, String list) {
    if (sender == null || list == null) return false;
    for (String allowed : list.split(","))
      if (!allowed.trim().isEmpty() && sender.equalsIgnoreCase(allowed.trim())) return true;
    return false;
  }

  static Expense parseSms(String text, String source) {
    if (text != null && "ru.sberbankmobile".equals(source))
      text = text.replaceAll("(?<=\\d)[рР](?=\\s|[.,;!]|$)", " RUB");
    Expense expense = parse(text, source);
    if (expense == null || !expense.kind.equals("expense") || !expense.merchant.isEmpty())
      return expense;
    String normalized = text.replace('\u00a0', ' ').replace('\u202f', ' ');
    Matcher amount = AMOUNT.matcher(normalized);
    if (!amount.find()) return expense;
    String tail = normalized.substring(amount.end());
    Matcher merchant =
        Pattern.compile(
                "^[ \\t]+(?:в[ \\t]+)?([^\\r\\n]{1,160}?)[ .;]*[ \\t]*(?:Баланс|Остаток|Доступно)[ \\t]*:",
                Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE)
            .matcher(tail);
    if (!merchant.find()) return expense;
    String name = merchant.group(1).trim();
    if (name.isEmpty()
        || Pattern.compile("[\\p{Cntrl}₽$€]|(?iu)карта|сч[её]т|\\*|•").matcher(name).find())
      return expense;
    return new Expense(expense.amount, expense.currency, name);
  }

  static Expense parse(String text) {
    return parse(text, "");
  }

  static Expense parse(String text, String source) {
    if (text == null || text.length() > 8000 || SECRET.matcher(text).find()) return null;
    Expense credit = credit(text, source);
    if (credit != null) return credit;
    if (OTHER.matcher(text).find()) return null;
    String normalized = text.replace('\u00a0', ' ').replace('\u202f', ' ');
    if ("ru.sberbankmobile".equals(source)) {
      Matcher standard = STANDARD.matcher(normalized);
      if (standard.find()) {
        String merchant = standard.group(1).replaceAll("\\s+", " ").trim();
        if (merchant.isEmpty()
            || Pattern.compile("[\\p{Cntrl}₽$€]").matcher(merchant).find()
            || AMOUNT.matcher(normalized.substring(standard.end())).find()) return null;
        return value(standard.group(2), standard.group(3), merchant);
      }
      if (normalized.startsWith("Покупка ")
          && normalized.contains("\n")
          && normalized.contains("Баланс:")) return null;
    }
    String merchant = "";
    Matcher m = SBER.matcher(normalized);
    if (!"ru.sberbankmobile".equals(source) || !m.find()) {
      m = AMOUNT.matcher(normalized);
      if (!m.find()) return null;
    } else {
      if (AMOUNT.matcher(normalized).find()) return null;
      merchant =
          normalized.substring("Приятные траты в ".length(), normalized.indexOf('\n')).trim();
      if (merchant.length() > 160 || Pattern.compile("[\\p{Cntrl}]").matcher(merchant).find())
        merchant = "";
    }
    String number = m.group(1), currency = m.group(2);
    return m.find() ? null : value(number, currency, merchant);
  }

  private static Expense credit(String text, String source) {
    if (!"ru.sberbankmobile".equals(source)) return null;
    String number = "(?:\\d{1,3}(?: \\d{3})+|\\d{1,10})(?:[.,]\\d{1,2})?",
        unit = "(?:₽|руб\\.?|RUB)";
    Pattern pattern =
        Pattern.compile(
            "\\A(Зачисление зарплаты|Возврат покупки|Возврат оплаты|Возврат средств)(?:[ \\t]+([^\\r\\n]{1,160}))?\\r?\\n[ \\t]*([+]?)((?:"
                + number
                + "))[ \\t]*("
                + unit
                + ")[ \\t]*[—–-][ \\t]*Баланс:[ \\t]*(?:"
                + number
                + ")[ \\t]*"
                + unit
                + "[ \\t]*\\z",
            Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    Matcher m = pattern.matcher(text.replace('\u00a0', ' ').replace('\u202f', ' '));
    if (!m.matches()) return null;
    boolean income = m.group(1).equalsIgnoreCase("Зачисление зарплаты");
    if (income && !m.group(3).equals("+")) return null;
    String name = m.group(2) == null ? "" : m.group(2).trim();
    if (Pattern.compile("(?iu)перевод|между|сво[ий]|отмен|отклон|ожида|заявк|\\p{Cntrl}|[₽$€]")
        .matcher(name)
        .find()) return null;
    Expense parsed = value(m.group(4), m.group(5), name);
    return parsed == null
        ? null
        : new Expense(parsed.amount, parsed.currency, name, income ? "income" : "refund");
  }

  private static Expense value(String number, String unit, String merchant) {
    try {
      long amount =
          new BigDecimal(number.replace(" ", "").replace(',', '.'))
              .movePointRight(2)
              .longValueExact();
      String currency = unit.toUpperCase(Locale.ROOT);
      currency =
          currency.equals("$") || currency.equals("USD")
              ? "USD"
              : currency.equals("€") || currency.equals("EUR") ? "EUR" : "RUB";
      return amount <= 0 || amount > 999999999999L ? null : new Expense(amount, currency, merchant);
    } catch (Exception e) {
      return null;
    }
  }
}

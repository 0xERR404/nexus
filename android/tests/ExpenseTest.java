package xyz.nexus404.hecate;

public final class ExpenseTest {
  public static void main(String[] args) {
    Expense sms =
        Expense.parseSms(
            "Счёт карты MIR-4746 19:50 Покупка 199р PRODUKTY 24 Баланс: 40 094.91р",
            "ru.sberbankmobile");
    if (sms == null || sms.amount != 19900 || !sms.merchant.equals("PRODUKTY 24"))
      throw new AssertionError("real Sber SMS");
    Expense value = Expense.parse("Карта *1234. Покупка 1\u00a0250,15 ₽. Баланс 9000 ₽");
    if (value == null || value.amount != 125015 || !value.currency.equals("RUB"))
      throw new AssertionError("purchase vs balance");
    value = Expense.parse("Payment 2.50 USD");
    if (value == null || value.amount != 250 || !value.currency.equals("USD"))
      throw new AssertionError("USD");
    if (!value.merchant.isEmpty()) throw new AssertionError("unknown merchant must stay empty");
    String[] blocked = {
      "Код: 1234. Оплата 9 RUB",
      "Пароль 123456",
      "Оплата 3 RUB отменена",
      "Перевод 50 RUB",
      "Баланс 500 RUB",
      "Покупка 0 RUB",
      "Покупка 3.999 RUB",
      "Покупка 1 RUB и оплата 2 RUB"
    };
    for (String text : blocked)
      if (Expense.parse(text) != null) throw new AssertionError("must not forward: " + text);
    String sber =
        "Приятные траты в Магнолия\n99,99 ₽ — В запасе: 12 345,67 ₽ Счёт карты МИР •• 1234";
    value = Expense.parse(sber, "ru.sberbankmobile");
    if (value == null || value.amount != 9999 || !value.currency.equals("RUB"))
      throw new AssertionError("Sber expense vs balance");
    if (!value.merchant.equals("Магнолия")) throw new AssertionError("Sber merchant");
    value =
        Expense.parse(
            sber.replace("99,99", "1\u202f299,99").replace(' ', '\u00a0'), "ru.sberbankmobile");
    if (value == null || value.amount != 129999) throw new AssertionError("Sber unicode spaces");
    if (Expense.parse(sber, "other.bank") != null) throw new AssertionError("Sber package scope");
    String[] invalidSber = {
      sber.replace("99,99 ₽ — ", ""),
      sber.replace("99,99", "99,999"),
      sber.replace("99,99", "0"),
      sber + " Возврат",
      sber + " Код: 1234",
      sber + " Покупка 20 RUB"
    };
    for (String text : invalidSber)
      if (Expense.parse(text, "ru.sberbankmobile") != null)
        throw new AssertionError("unsafe Sber amount");
    String standard = "Покупка Магазин у дома\n1 978 ₽ — Баланс: 54 362 ₽";
    value = Expense.parse(standard, "ru.sberbankmobile");
    if (value == null
        || value.amount != 197800
        || !value.currency.equals("RUB")
        || !value.merchant.equals("Магазин у дома"))
      throw new AssertionError("Standard purchase and merchant");
    value =
        Expense.parse(
            standard
                .replace("Магазин у дома", "Магазин\nу дома")
                .replace(' ', '\u202f')
                .replace("1\u202f978", "99,99"),
            "ru.sberbankmobile");
    if (value == null || value.amount != 9999 || !value.merchant.equals("Магазин у дома"))
      throw new AssertionError("Standard wrapped title and spaces");
    String[] invalidStandard = {
      standard.replace("1 978 ₽ — ", ""),
      standard.replace("1 978", "1 978,999"),
      standard.replace("1 978", "+1 978"),
      standard.replace("1 978", "0"),
      standard + " Оплата 20 RUB",
      standard + " отменена",
      "Перевод от Отправитель\n+5 000 ₽ — Баланс: 12 300 ₽"
    };
    for (String text : invalidStandard)
      if (Expense.parse(text, "ru.sberbankmobile") != null)
        throw new AssertionError("Standard must not charge invalid purchase or income");
    if (Expense.parse(standard, "other.bank") != null)
      throw new AssertionError("Standard bank scope");
    value =
        Expense.parseSms(
            "VISA1234 30.09.26 19:00 Покупка 199,90 RUB MAGNOLIA. Баланс: 5000 RUB",
            "ru.sberbankmobile");
    if (value == null || value.amount != 19990 || !value.merchant.equals("MAGNOLIA"))
      throw new AssertionError("SMS merchant and amount");
    if (!Expense.allowedSender("900", "900,SBER")
        || !Expense.allowedSender("sber", "900,SBER")
        || Expense.allowedSender("+7900", "900")
        || Expense.allowedSender("9000", "900")
        || Expense.allowedSender(null, "900")) throw new AssertionError("exact sender allowlist");
    for (String text : blocked)
      if (Expense.parseSms(text, "ru.sberbankmobile") != null)
        throw new AssertionError("SMS secret or ambiguous operation");
    String salary = "Зачисление зарплаты ПАО СберБанк\n+54 000 ₽ — Баланс: 83 000 ₽";
    value = Expense.parse(salary, "ru.sberbankmobile");
    if (value == null || !value.kind.equals("income") || value.amount != 5400000)
      throw new AssertionError("salary");
    String refund = "Возврат покупки Магнолия\n+99,99 ₽ — Баланс: 83 000 ₽";
    value = Expense.parse(refund, "ru.sberbankmobile");
    if (value == null
        || !value.kind.equals("refund")
        || value.amount != 9999
        || !value.merchant.equals("Магнолия")) throw new AssertionError("refund");
    for (String text :
        new String[] {
          salary.replace("+54", "54"),
          refund.replace("+99", "-99"),
          refund + " Код: 1234",
          refund + " отменён",
          refund.replace("Магнолия", "ожидается"),
          "Перевод между своими счетами\n+500 ₽ — Баланс: 1000 ₽"
        })
      if (Expense.parse(text, "ru.sberbankmobile") != null)
        throw new AssertionError("unsafe credit: " + text);
    if (Expense.parse(salary, "other.bank") != null) throw new AssertionError("credit bank scope");
    System.out.println("Android parser: passed");
  }
}

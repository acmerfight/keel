import { secretLikeTextLabel } from "./secret-text.ts";

export type ProhibitedSensitiveCategory =
  | "secret"
  | "contact"
  | "identity"
  | "financial"
  | "health"
  | "private_customer"
  | "address";

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/iu;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/u;
const CHINESE_RESIDENT_ID_PATTERN = /\b\d{17}[0-9X]\b/iu;
const PHONE_PATTERN =
  /(?:\+\d{1,3}[ .()-]*)?(?:\(\d{2,4}\)[ .-]*|\d{2,4}[ .-])\d{3,4}[ .-]\d{4}\b/u;
const LABELED_IDENTITY_PATTERN =
  /(?:passport(?: number)?|government id|national id|护照号|身份证号)\s*[:：]\s*\S/iu;
const LABELED_FINANCIAL_PATTERN =
  /(?:bank account(?: number)?|routing number|银行卡号|银行账户)\s*[:：]\s*\S/iu;
const LABELED_HEALTH_PATTERN =
  /(?:medical diagnosis|medical record|health condition|诊断|病历|健康状况)\s*[:：]\s*\S/iu;
const LABELED_CUSTOMER_PATTERN =
  /(?:private customer data|confidential customer data|客户隐私数据|客户机密数据)\s*[:：]\s*\S/iu;
const LABELED_ADDRESS_PATTERN =
  /(?:home address|personal address|家庭住址|家庭地址|住址)\s*[:：]\s*\S/iu;
const PAYMENT_CARD_PATTERN = /(?:\d[ -]*){13,19}/gu;

function luhnValid(value: string): boolean {
  const digits = [...value].map(Number);
  let sum = 0;
  const parity = digits.length % 2;
  for (const [index, digit] of digits.entries()) {
    let contribution = digit;
    if (index % 2 === parity) {
      contribution *= 2;
      if (contribution > 9) contribution -= 9;
    }
    sum += contribution;
  }
  return sum % 10 === 0;
}

function containsPaymentCard(text: string): boolean {
  PAYMENT_CARD_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(PAYMENT_CARD_PATTERN)) {
    const digits = match[0].replaceAll(/[ -]/gu, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      PAYMENT_CARD_PATTERN.lastIndex = 0;
      return true;
    }
  }
  PAYMENT_CARD_PATTERN.lastIndex = 0;
  return false;
}

export function prohibitedSensitiveTextCategory(
  text: string,
): ProhibitedSensitiveCategory | undefined {
  if (secretLikeTextLabel(text) !== undefined) return "secret";
  if (containsPaymentCard(text) || LABELED_FINANCIAL_PATTERN.test(text)) {
    return "financial";
  }
  if (EMAIL_PATTERN.test(text) || PHONE_PATTERN.test(text)) return "contact";
  if (
    SSN_PATTERN.test(text) ||
    CHINESE_RESIDENT_ID_PATTERN.test(text) ||
    LABELED_IDENTITY_PATTERN.test(text)
  ) {
    return "identity";
  }
  if (LABELED_HEALTH_PATTERN.test(text)) return "health";
  if (LABELED_CUSTOMER_PATTERN.test(text)) return "private_customer";
  if (LABELED_ADDRESS_PATTERN.test(text)) return "address";
  return undefined;
}

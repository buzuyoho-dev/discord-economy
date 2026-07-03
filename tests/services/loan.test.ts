import { describe, expect, test } from 'vitest';
import { prisma } from '../../src/db/client';
import { CreditBannedError } from '../../src/services/creditBan';
import { BotTargetError } from '../../src/services/discordTargetGuard';
import { getOrCreateHouse, HOUSE_ID } from '../../src/services/house';
import { getOrCreateUser, InsufficientBalanceError } from '../../src/services/ledger';
import {
  calculateInterest,
  calculateOverdueDays,
  CannotLoanToSelfError,
  createLoan,
  InvalidDueDateError,
  InvalidLoanAmountError,
  LoanAmountTooLargeError,
  LoanNotActiveError,
  LoanNotFoundError,
  MAX_LOAN_AMOUNT,
  NotBorrowerError,
  repayLoan,
} from '../../src/services/loan';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

describe('calculateOverdueDays', () => {
  test('상환일 전이면 0일이다', () => {
    const dueAt = new Date('2026-07-01T00:00:00.000Z');
    const now = new Date('2026-06-30T00:00:00.000Z');
    expect(calculateOverdueDays(dueAt, now)).toBe(0);
  });

  test('상환일로부터 N일 지나면 N일로 계산된다', () => {
    const dueAt = new Date('2026-07-01T00:00:00.000Z');
    const now = new Date('2026-07-04T00:00:00.000Z');
    expect(calculateOverdueDays(dueAt, now)).toBe(3);
  });

  test('10일을 초과해도 최대 10일로 캡된다', () => {
    const dueAt = new Date('2026-07-01T00:00:00.000Z');
    const now = new Date('2026-07-20T00:00:00.000Z');
    expect(calculateOverdueDays(dueAt, now)).toBe(10);
  });
});

describe('calculateInterest', () => {
  test('단리로 원금의 5% x 연체일수, 내림 처리한다', () => {
    expect(calculateInterest(1_000_000, 3)).toBe(150_000);
    expect(calculateInterest(1_000_001, 3)).toBe(Math.floor(1_000_001 * 0.05 * 3));
  });

  test('연체일수 0이면 이자 0이다', () => {
    expect(calculateInterest(1_000_000, 0)).toBe(0);
  });
});

describe('createLoan', () => {
  test('정상 개설: 대출자는 원금만큼 차감, 차입자는 수수료 제외 수령, 하우스는 개설 수수료(2%)만 받는다', async () => {
    await getOrCreateUser('lender-1');
    await getOrCreateUser('borrower-1');
    await getOrCreateHouse();

    const loan = await createLoan({
      lenderId: 'lender-1',
      borrowerId: 'borrower-1',
      principal: 1_000_000,
    });

    expect(loan.status).toBe('ACTIVE');
    expect(loan.principal).toBe(1_000_000);

    const lender = await prisma.user.findUniqueOrThrow({ where: { discordId: 'lender-1' } });
    const borrower = await prisma.user.findUniqueOrThrow({ where: { discordId: 'borrower-1' } });
    const house = await prisma.house.findUniqueOrThrow({ where: { id: HOUSE_ID } });

    expect(lender.balance).toBe(10_000_000 - 1_000_000);
    expect(borrower.balance).toBe(10_000_000 + 1_000_000 - 20_000); // 2% 수수료 제외
    expect(house.balance).toBe(20_000);
  });

  test('상환일을 지정하지 않으면 기본 7일 후로 설정된다', async () => {
    await getOrCreateUser('lender-2');
    await getOrCreateUser('borrower-2');
    await getOrCreateHouse();

    const now = new Date('2026-06-21T00:00:00.000Z');
    const loan = await createLoan({
      lenderId: 'lender-2',
      borrowerId: 'borrower-2',
      principal: 1_000_000,
      now,
    });

    expect(loan.dueAt.getTime()).toBe(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  });

  test('3,000만 포인트를 초과하면 거부된다', async () => {
    await getOrCreateUser('lender-3');
    await getOrCreateUser('borrower-3');

    await expect(
      createLoan({ lenderId: 'lender-3', borrowerId: 'borrower-3', principal: MAX_LOAN_AMOUNT + 1 })
    ).rejects.toThrow(LoanAmountTooLargeError);
  });

  test('본인에게 대출을 개설하면 거부된다', async () => {
    await getOrCreateUser('lender-4');

    await expect(
      createLoan({ lenderId: 'lender-4', borrowerId: 'lender-4', principal: 1_000 })
    ).rejects.toThrow(CannotLoanToSelfError);
  });

  test('빌릴 사람이 봇이면 거부되고 아무도 차감/생성되지 않는다', async () => {
    await getOrCreateUser('lender-bot-1');

    await expect(
      createLoan({
        lenderId: 'lender-bot-1',
        borrowerId: 'bot-1',
        borrowerIsBot: true,
        principal: 1_000_000,
      })
    ).rejects.toThrow(BotTargetError);

    const lender = await prisma.user.findUniqueOrThrow({ where: { discordId: 'lender-bot-1' } });
    expect(lender.balance).toBe(10_000_000); // 차감 없음

    const botUser = await prisma.user.findUnique({ where: { discordId: 'bot-1' } });
    expect(botUser).toBeNull();
  });

  test.each([NaN, -5, 0, 1.5, Infinity])('금액이 %s이면 거부된다', async (principal) => {
    await getOrCreateUser('lender-5');
    await getOrCreateUser('borrower-5');

    await expect(
      createLoan({ lenderId: 'lender-5', borrowerId: 'borrower-5', principal })
    ).rejects.toThrow(InvalidLoanAmountError);
  });

  test('dueAt이 현재 시점보다 과거이거나 같으면 거부된다', async () => {
    await getOrCreateUser('lender-13');
    await getOrCreateUser('borrower-13');
    await getOrCreateHouse();

    const now = new Date('2026-06-21T00:00:00.000Z');

    await expect(
      createLoan({
        lenderId: 'lender-13',
        borrowerId: 'borrower-13',
        principal: 1_000_000,
        now,
        dueAt: new Date('2026-06-20T00:00:00.000Z'), // 과거
      })
    ).rejects.toThrow(InvalidDueDateError);

    await expect(
      createLoan({
        lenderId: 'lender-13',
        borrowerId: 'borrower-13',
        principal: 1_000_000,
        now,
        dueAt: now, // 현재 시점과 동일 (미래가 아님)
      })
    ).rejects.toThrow(InvalidDueDateError);
  });

  test('차입자가 신용불량 상태면 신규 대출 개설이 거부된다', async () => {
    await getOrCreateUser('lender-14');
    await getOrCreateUser('borrower-14');
    await getOrCreateUser('other-lender-14');
    await getOrCreateHouse();

    const oldLoan = await createLoan({
      lenderId: 'lender-14',
      borrowerId: 'borrower-14',
      principal: 1_000_000,
      now: new Date('2026-06-01T00:00:00.000Z'),
      dueAt: new Date('2026-06-08T00:00:00.000Z'),
    });

    const elevenDaysLate = new Date(oldLoan.dueAt.getTime() + 11 * ONE_DAY_MS);

    await expect(
      createLoan({
        lenderId: 'other-lender-14',
        borrowerId: 'borrower-14',
        principal: 500_000,
        now: elevenDaysLate,
      })
    ).rejects.toThrow(CreditBannedError);
  });
});

describe('repayLoan', () => {
  test('상환일 전에 상환하면 이자 없이 원금만 전달된다', async () => {
    await getOrCreateUser('lender-6');
    await getOrCreateUser('borrower-6');
    await getOrCreateHouse();

    const createdAt = new Date('2026-06-21T00:00:00.000Z');
    const loan = await createLoan({
      lenderId: 'lender-6',
      borrowerId: 'borrower-6',
      principal: 1_000_000,
      now: createdAt,
    });

    const repaidAt = new Date('2026-06-25T00:00:00.000Z'); // 상환일(7일 후) 전
    const result = await repayLoan({ loanId: loan.id, repaidBy: 'borrower-6', now: repaidAt });

    expect(result.interest).toBe(0);
    expect(result.totalRepaid).toBe(1_000_000);
    expect(result.loan.status).toBe('REPAID');

    const lender = await prisma.user.findUniqueOrThrow({ where: { discordId: 'lender-6' } });
    // 대출 실행 시 -1,000,000, 상환 수령 시 +1,000,000 => 원래 잔액으로 복귀
    expect(lender.balance).toBe(10_000_000);
  });

  test('상환일이 지나면 연체일수 x 5% 단리 이자가 함께 청구된다', async () => {
    await getOrCreateUser('lender-7');
    await getOrCreateUser('borrower-7');
    await getOrCreateHouse();

    const createdAt = new Date('2026-06-21T00:00:00.000Z');
    const loan = await createLoan({
      lenderId: 'lender-7',
      borrowerId: 'borrower-7',
      principal: 1_000_000,
      now: createdAt,
    }); // dueAt = 2026-06-28

    const repaidAt = new Date('2026-07-01T00:00:00.000Z'); // 3일 연체
    const result = await repayLoan({ loanId: loan.id, repaidBy: 'borrower-7', now: repaidAt });

    expect(result.interest).toBe(150_000); // 1,000,000 * 0.05 * 3
    expect(result.totalRepaid).toBe(1_150_000);

    const lender = await prisma.user.findUniqueOrThrow({ where: { discordId: 'lender-7' } });
    // -1,000,000(대출) + 1,150,000(상환+이자) = +150,000
    expect(lender.balance).toBe(10_000_000 + 150_000);

    const borrower = await prisma.user.findUniqueOrThrow({ where: { discordId: 'borrower-7' } });
    // +1,000,000-20,000(수수료) - 1,150,000(상환) = -170,000
    expect(borrower.balance).toBe(10_000_000 - 170_000);
  });

  test('10일을 초과한 연체도 이자는 10일치(원금의 50%)로 캡된다', async () => {
    await getOrCreateUser('lender-8');
    await getOrCreateUser('borrower-8');
    await getOrCreateHouse();

    const createdAt = new Date('2026-06-21T00:00:00.000Z');
    const loan = await createLoan({
      lenderId: 'lender-8',
      borrowerId: 'borrower-8',
      principal: 1_000_000,
      now: createdAt,
    }); // dueAt = 2026-06-28

    const repaidAt = new Date('2026-07-20T00:00:00.000Z'); // 22일 연체 (10일 초과)
    const result = await repayLoan({ loanId: loan.id, repaidBy: 'borrower-8', now: repaidAt });

    expect(result.interest).toBe(500_000); // 원금의 50%로 캡
    expect(result.totalRepaid).toBe(1_500_000);
  });

  test('이미 상환된 대출을 다시 상환하면 거부된다', async () => {
    await getOrCreateUser('lender-9');
    await getOrCreateUser('borrower-9');
    await getOrCreateHouse();

    const loan = await createLoan({ lenderId: 'lender-9', borrowerId: 'borrower-9', principal: 1_000_000 });
    await repayLoan({ loanId: loan.id, repaidBy: 'borrower-9' });

    await expect(repayLoan({ loanId: loan.id, repaidBy: 'borrower-9' })).rejects.toThrow(
      LoanNotActiveError
    );
  });

  test('차입자가 아닌 사람이 상환을 시도하면 거부된다', async () => {
    await getOrCreateUser('lender-10');
    await getOrCreateUser('borrower-10');
    await getOrCreateHouse();

    const loan = await createLoan({
      lenderId: 'lender-10',
      borrowerId: 'borrower-10',
      principal: 1_000_000,
    });

    await expect(repayLoan({ loanId: loan.id, repaidBy: 'someone-else' })).rejects.toThrow(
      NotBorrowerError
    );
  });

  test('존재하지 않는 대출을 상환하려 하면 거부된다', async () => {
    await expect(repayLoan({ loanId: 999_999, repaidBy: 'nobody' })).rejects.toThrow(
      LoanNotFoundError
    );
  });

  test('동시에 같은 대출을 두 번 상환 시도해도 처리는 정확히 한 번만 일어난다', async () => {
    await getOrCreateUser('lender-11');
    await getOrCreateUser('borrower-11');
    await getOrCreateHouse();

    const loan = await createLoan({
      lenderId: 'lender-11',
      borrowerId: 'borrower-11',
      principal: 1_000_000,
    });

    const results = await Promise.allSettled([
      repayLoan({ loanId: loan.id, repaidBy: 'borrower-11' }),
      repayLoan({ loanId: loan.id, repaidBy: 'borrower-11' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LoanNotActiveError);

    const lender = await prisma.user.findUniqueOrThrow({ where: { discordId: 'lender-11' } });
    // 상환이 두 번 일어났다면 1,000,000을 두 번 받아 11,000,000이 됨 - 정상은 한 번만 받아 10,000,000
    expect(lender.balance).toBe(10_000_000);
  });

  test('차입자 잔액이 상환액(원금+이자)보다 적으면 InsufficientBalanceError로 거부되고 대출은 ACTIVE로 유지된다', async () => {
    await getOrCreateUser('lender-12');
    await getOrCreateUser('borrower-12');
    await getOrCreateHouse();

    const loan = await createLoan({
      lenderId: 'lender-12',
      borrowerId: 'borrower-12',
      principal: 1_000_000,
    });

    // 대출 수령 후 차입자가 다 써버려서 상환액보다 잔액이 부족한 상황을 시뮬레이션한다.
    await prisma.user.update({ where: { discordId: 'borrower-12' }, data: { balance: 500_000 } });

    await expect(repayLoan({ loanId: loan.id, repaidBy: 'borrower-12' })).rejects.toThrow(
      InsufficientBalanceError
    );

    const loanAfter = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(loanAfter.status).toBe('ACTIVE'); // 부분 처리된 채로 남지 않음

    const borrower = await prisma.user.findUniqueOrThrow({ where: { discordId: 'borrower-12' } });
    expect(borrower.balance).toBe(500_000); // 변경 없음

    const lender = await prisma.user.findUniqueOrThrow({ where: { discordId: 'lender-12' } });
    // 차입자 차감이 실패했으므로 대출자에게 상환금이 지급되지도 않아야 함
    expect(lender.balance).toBe(10_000_000 - 1_000_000);
  });
});

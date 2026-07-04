import { describe, expect, test } from 'vitest';
import { formatMyLoans, type MyLoansViewLoan } from '../../src/commands/loanView';

function makeLoan(overrides: Partial<MyLoansViewLoan> & { id: number }): MyLoansViewLoan {
  return {
    lenderId: 'lender-1',
    borrowerId: 'borrower-1',
    principal: 1_000_000,
    status: 'ACTIVE',
    dueAt: new Date('2026-07-10T00:00:00.000Z'),
    dueDays: 7,
    ...overrides,
  };
}

describe('formatMyLoans', () => {
  test('보낸 요청/받은 요청이 없으면 각 섹션에 없음으로 표시된다', () => {
    const text = formatMyLoans({ asLender: [], asBorrower: [], showAll: false });

    expect(text).toContain('내가 보낸 요청');
    expect(text).toContain('내가 받은 요청');
    expect(text).toContain('없음');
  });

  test('PENDING인 borrower 항목(내가 요청을 보낸 것)은 보낸 요청 섹션에, PENDING인 lender 항목(내가 요청을 받은 것)은 받은 요청 섹션에 표시된다', () => {
    const sent = makeLoan({ id: 1, status: 'PENDING', lenderId: 'someone-l', dueAt: null });
    const received = makeLoan({ id: 2, status: 'PENDING', borrowerId: 'someone-b', dueAt: null });

    const text = formatMyLoans({ asBorrower: [sent], asLender: [received], showAll: false });

    const sentIdx = text.indexOf('내가 보낸 요청');
    const receivedIdx = text.indexOf('내가 받은 요청');
    const loan1Idx = text.indexOf('대출 #1');
    const loan2Idx = text.indexOf('대출 #2');

    expect(sentIdx).toBeGreaterThanOrEqual(0);
    expect(receivedIdx).toBeGreaterThan(sentIdx);
    expect(loan1Idx).toBeGreaterThan(sentIdx);
    expect(loan1Idx).toBeLessThan(receivedIdx);
    expect(loan2Idx).toBeGreaterThan(receivedIdx);
  });

  test('ACTIVE 항목은 대출ID가 굵게 강조된다', () => {
    const active = makeLoan({ id: 5, status: 'ACTIVE' });
    const text = formatMyLoans({ asLender: [active], asBorrower: [], showAll: false });

    expect(text).toContain('**대출 #5**');
  });

  test('PENDING 항목은 dueAt 대신 dueDays 기반 안내 문구를 보여준다', () => {
    const pending = makeLoan({ id: 6, status: 'PENDING', dueAt: null, dueDays: 10 });
    const text = formatMyLoans({ asLender: [pending], asBorrower: [], showAll: false });

    expect(text).toContain('10일');
    expect(text).not.toMatch(/2026\.\s*7\.\s*10\.|2026-07-10/);
  });

  test('완료된(REPAID/DECLINED/VOIDED) 항목은 기본적으로 최근 3건만 보이고 나머지는 안내 문구로 요약된다', () => {
    const finished = [1, 2, 3, 4, 5].map((n) =>
      makeLoan({ id: n, status: 'REPAID', dueAt: new Date(`2026-07-0${n}T00:00:00.000Z`) })
    );
    const text = formatMyLoans({ asLender: finished, asBorrower: [], showAll: false });

    expect(text).toContain('대출 #1');
    expect(text).toContain('대출 #2');
    expect(text).toContain('대출 #3');
    expect(text).not.toContain('대출 #4');
    expect(text).not.toContain('대출 #5');
    expect(text).toContain('전체보기');
  });

  test('전체보기 옵션이 true면 완료된 항목이 전부 표시된다', () => {
    const finished = [1, 2, 3, 4, 5].map((n) =>
      makeLoan({ id: n, status: 'REPAID', dueAt: new Date(`2026-07-0${n}T00:00:00.000Z`) })
    );
    const text = formatMyLoans({ asLender: finished, asBorrower: [], showAll: true });

    expect(text).toContain('대출 #4');
    expect(text).toContain('대출 #5');
  });

  test('DECLINED 항목은 dueDays 힌트를 보여주지 않는다 (수락된 적이 없어 의미가 없음)', () => {
    const declined = makeLoan({ id: 8, status: 'DECLINED', dueAt: null, dueDays: 7 });
    const text = formatMyLoans({ asLender: [declined], asBorrower: [], showAll: false });

    expect(text).not.toContain('7일');
    expect(text).toContain('대출 #8');
  });

  test('ACTIVE/완료 항목은 실제 dueAt 날짜를 보여준다', () => {
    const active = makeLoan({ id: 7, status: 'ACTIVE', dueAt: new Date('2026-07-10T00:00:00.000Z') });
    const text = formatMyLoans({ asLender: [active], asBorrower: [], showAll: false });

    expect(text).toMatch(/2026\. ?7\. ?10\.|2026-07-10/);
  });
});

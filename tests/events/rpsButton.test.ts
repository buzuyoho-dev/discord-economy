import { describe, expect, test } from 'vitest';
import { assertAuthorizedResponder, UnauthorizedResponderError } from '../../src/events/rpsButton';

describe('assertAuthorizedResponder', () => {
  test('지목된 상대방 본인이 클릭했으면 통과한다', () => {
    expect(() => assertAuthorizedResponder('opponent-1', 'opponent-1')).not.toThrow();
  });

  test('지목된 상대방이 아닌 다른 사람이 클릭했으면 거부한다', () => {
    expect(() => assertAuthorizedResponder('someone-else', 'opponent-1')).toThrow(
      UnauthorizedResponderError
    );
  });

  test('챌린저 본인이 눌러도(자기 도전에) 거부한다', () => {
    expect(() => assertAuthorizedResponder('challenger-1', 'opponent-1')).toThrow(
      UnauthorizedResponderError
    );
  });
});

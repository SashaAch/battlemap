// Every error code the server sends, with its HTTP status (plan 6.4). The client shows the text for
// `error.<code>` from its dictionaries; test/auth.test.ts checks that both dictionaries have all of them.

export const ERRORS = {
  "request.notFound": 404,
  "request.host": 403,
  "request.origin": 403,
  "request.contentType": 415,
  "request.tooLarge": 413,
  "request.format": 400,
  "auth.required": 401,
  "auth.invalid": 401,
  "auth.tooManyAttempts": 429,
  "auth.tooManyRegistrations": 429,
  "auth.disabled": 403,
  "auth.mustChangePassword": 403,
  "auth.forbidden": 403,
  "auth.inviteInvalid": 403,
  "auth.setupInvalid": 403,
  "login.format": 400,
  "login.taken": 400,
  "name.format": 400,
  "password.format": 400,
  "password.wrong": 403,
  "password.same": 400,
  "admin.self": 400,
  "user.notFound": 404,
  "game.notFound": 404,
  "game.title": 400,
  "member.notFound": 404,
  "member.protected": 400,
  "scene.notFound": 404,
  "scene.name": 400,
  "scene.patch": 400,
  "scene.tooLarge": 413,
  "invite.notFound": 404,
  "invite.expired": 410,
  "invite.tooManyAttempts": 429,
  "stream.tooMany": 429,
  "ping.tooMany": 429,
  "server.error": 500,
} as const;

export type ErrorCode = keyof typeof ERRORS;

/** Thrown anywhere in request handling; the server answers `{ "error": code }` with the code's status. */
export class ApiError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(code);
    this.code = code;
  }

  get status(): number {
    return ERRORS[this.code];
  }
}

export class KeelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeelError";
  }
}

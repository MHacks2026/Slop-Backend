/** A feature the direct proposers cannot express; the planner decides what to do next. */
export class ProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalError";
  }
}

import { IntegrationError } from "../../core/integrations/types";

/**
 * The `IntegrationError` a promise rejects with. Fails the test when the promise resolves or
 * rejects with anything else, so the assertions that follow read a real, typed error.
 */
export async function integrationErrorOf(promise: Promise<unknown>): Promise<IntegrationError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof IntegrationError) return err;
    throw err;
  }
  throw new Error("expected the promise to reject with an IntegrationError");
}

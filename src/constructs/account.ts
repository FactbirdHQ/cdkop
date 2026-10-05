import { Construct } from 'constructs';

export interface AccountProps {
  /**
   * The account's sign-in address, as `op account list` prints it, e.g.
   * `example.1password.com`. Every `op` call is pinned to it with `--account`,
   * and `plan` refuses to run when the session reaches a different account.
   */
  readonly signInAddress: string;
}

/**
 * A 1Password Business account: the root every `Vault`, `Group` and
 * `ScimProvisioning` is declared under.
 */
export class Account extends Construct {
  public readonly props: AccountProps;

  constructor(scope: Construct, id: string, props: AccountProps) {
    super(scope, id);
    this.props = props;
  }
}

# Action

Managing Github Copilot licenses can be a pain. Run this action to get a report of inactive users and optionally remove them.

## Usage
Create a workflow (eg: `.github/workflows/copilot-license-cleanup.yml`). See [Creating a Workflow file](https://help.github.com/en/articles/configuring-a-workflow#creating-a-workflow-file).


### PAT(Personal Access Token)

You will need to [create a PAT(Personal Access Token)](https://github.com/settings/tokens/new?scopes=manage_billing:copilot) that has `manage_billing:copilot` access.

Add this PAT as a secret `TOKEN` so we can use it for input `github-token`, see [Creating encrypted secrets for a repository](https://docs.github.com/en/enterprise-cloud@latest/actions/security-guides/encrypted-secrets#creating-encrypted-secrets-for-a-repository). 
### Organizations

If your organization has SAML enabled you must authorize the PAT, see [Authorizing a personal access token for use with SAML single sign-on](https://docs.github.com/en/enterprise-cloud@latest/authentication/authenticating-with-saml-single-sign-on/authorizing-a-personal-access-token-for-use-with-saml-single-sign-on).


#### Example
```yml
name: Cleanup Copilot Licenses
on:
  workflow_dispatch:
  schedule:
    - cron: '0 0 * * *'

jobs:
  copilot:
    name: Copilot Seats
    runs-on: ubuntu-latest
    steps:
      - uses: austenstone/copilot-license-cleanup@main
        with:
          github-token: ${{ secrets.TOKEN }}
          organization: 'octodemo'
          remove: false
          inactive-days: 30
```

## ➡️ Inputs
Various inputs are defined in [`action.yml`](action.yml):

| Name | Description | Default |
| --- | - | - |
| **github&#x2011;token** | Token to use to authorize. | ${{&nbsp;github.token&nbsp;}} |
| **organization** | The organization to use for the action | ${{&nbsp;github.repository_owner&nbsp;}} |
| remove | Whether to remove inactive users | false |
| inactive&#x2011;days | The number of days to consider a user inactive | 90 |
| job-summary | Whether to output a summary of the job | true |
| csv | Whether to output a CSV of inactive users | false |

## ⬅️ Outputs
| Name | Description |
| --- | - |
| inactive-seats | JSON array of inactive seats |
| inactive-seat-count | The number of inactive seats |
| removed-seats | The number of seats removed |
| seat-count | The total number of seats |

## Further help
To get more help on the Actions see [documentation](https://docs.github.com/en/actions).

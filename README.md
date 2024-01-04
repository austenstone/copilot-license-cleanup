# Copilot License Cleanup

Run this action on a schedule to automatically remove inactive Copilot licenses. It also creates a report as a job summary and csv.

## Usage
Create a workflow (eg: `.github/workflows/copilot-license-cleanup.yml`). See [Creating a Workflow file](https://help.github.com/en/articles/configuring-a-workflow#creating-a-workflow-file).


### PAT(Personal Access Token)

You will need to [create a PAT(Personal Access Token)](https://github.com/settings/tokens/new?scopes=manage_billing:copilot) that has `manage_billing:copilot` access.  If you are specifying an 'enterprise' rather than individual organizations you must also include the `read:org` and `read:enterprise` scopes. 

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
      - uses: austenstone/copilot-license-cleanup@v1.1
        with:
          github-token: ${{ secrets.TOKEN }}
```

#### Example Auto remove
```yml
      - uses: austenstone/copilot-license-cleanup@v1.1
        with:
          github-token: ${{ secrets.TOKEN }}
          remove: true
          remove-from-team: true
```

#### Example Custom days before inactive
```yml
      - uses: austenstone/copilot-license-cleanup@v1.1
        with:
          github-token: ${{ secrets.TOKEN }}
          remove: true
          remove-from-team: true
          inactive-days: 10
```

#### Example Specifying multiple organizations: 
```yml
      - uses: austenstone/copilot-license-cleanup@v1.1
        with:
          github-token: ${{ secrets.TOKEN }}
          organization: exampleorg1, demoorg2, myorg3
```

#### Example specifying a GitHub Enterprise (to run on all organizations in the enterprise):
```yml
      - uses: austenstone/copilot-license-cleanup@v1.1
        with:
          github-token: ${{ secrets.TOKEN }}
          enterprise: octodemo
```

#### Example uploading inactive users JSON artifact
```yml
      - uses: austenstone/copilot-license-cleanup@v1.1
        id: copilot
        with:
          github-token: ${{ secrets.TOKEN }}
      - name: Save inactive seats JSON to a file
        run: |
          echo '${{ steps.copilot.outputs.inactive-seats }}' | jq . > inactive-seats.json
      - name: Upload inactive seats JSON as artifact
        uses: actions/upload-artifact@v4
        with:
          name: inactive-seats-json
          path: inactive-seats.json
```

<details>
  <summary>Job summary example</summary>
  
  <img src="https://github.com/austenstone/copilot-license-cleanup/assets/22425467/4695fc23-e9c7-4403-ba04-2de0e2d36242"/>
  
</details>


## ➡️ Inputs
Various inputs are defined in [`action.yml`](action.yml):

| Name | Description | Default |
| --- | - | - |
| **github&#x2011;token** | Token to use to authorize. | ${{&nbsp;github.token&nbsp;}} |
| organization | The organization(s) to use for the action (comma separated)| ${{&nbsp;github.repository_owner&nbsp;}} |
| enterprise | (optional) All organizations in this enterprise (overrides organization) | null |
| remove | Whether to remove inactive users | false |
| remove-from-team | Whether to remove inactive users from their assigning team | false |
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

## How does it work?
We're simply leveraging the [GitHub Copilot API](https://docs.github.com/en/rest/copilot). First we fetch all the Copilot seats and filter them to only inactive seats. Then if the seat is assigned directly we remove it but if it's assigned through a team we remove the user from the team. Those inactive users are reported as a CSV and a job summary table.

## Further help
To get more help on the Actions see [documentation](https://docs.github.com/en/actions).

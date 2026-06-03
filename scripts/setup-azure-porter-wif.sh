#!/bin/bash

# Porter Azure Workload Identity Federation Setup Script
# Sets up an Azure App Registration with a federated identity credential for Porter.
# No client secret is generated — Porter authenticates via OIDC instead.

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}$1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}$1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_info() {
    echo -e "${YELLOW}$1${NC}"
}

# Function to check prerequisites
check_prerequisites() {
    print_status "Checking prerequisites..."

    # Check if Azure CLI is installed
    if ! command -v az &> /dev/null; then
        print_error "Azure CLI not found. Please install it from https://docs.microsoft.com/en-us/cli/azure/install-azure-cli"
        exit 1
    fi

    # Check if logged in
    if ! az account show &> /dev/null; then
        print_error "Not logged in to Azure CLI. Please run 'az login' first"
        exit 1
    fi

    print_success "Prerequisites check passed"
}

# Function to get and validate subscription ID
get_subscription_id() {
    # Check if subscription ID was provided as argument
    if [ -n "$1" ]; then
        SUBSCRIPTION_ID="$1"
    else
        # Prompt user for subscription ID
        echo ""
        print_status "Available subscriptions:"
        az account list --query "[].{Name:name, SubscriptionId:id, State:state}" -o table
        echo ""
        read -p "Enter the subscription ID you want to use: " SUBSCRIPTION_ID

        if [ -z "$SUBSCRIPTION_ID" ]; then
            print_error "Subscription ID is required"
            exit 1
        fi
    fi

    # Validate subscription ID exists and is accessible
    if ! az account show --subscription "$SUBSCRIPTION_ID" &> /dev/null; then
        print_error "Subscription '$SUBSCRIPTION_ID' not found or not accessible"
        print_info "Available subscriptions:"
        az account list --query "[].{Name:name, SubscriptionId:id, State:state}" -o table
        exit 1
    fi

    # Get subscription details for confirmation
    SUB_NAME=$(az account show --subscription "$SUBSCRIPTION_ID" --query name -o tsv)
    SUB_STATE=$(az account show --subscription "$SUBSCRIPTION_ID" --query state -o tsv)

    if [ "$SUB_STATE" != "Enabled" ]; then
        print_error "Subscription '$SUBSCRIPTION_ID' is not enabled (state: $SUB_STATE)"
        exit 1
    fi

    # Set the subscription as active
    az account set --subscription "$SUBSCRIPTION_ID"

    print_success "Using subscription: $SUB_NAME ($SUBSCRIPTION_ID)"
}

# Function to get and validate OIDC subject
get_oidc_subject() {
    # Check if OIDC subject was provided as argument
    if [ -n "$1" ]; then
        OIDC_SUBJECT="$1"
    else
        echo ""
        print_info "Copy the OIDC subject shown in Porter during the Azure cloud account connection steps."
        echo ""
        read -p "Enter the OIDC subject (e.g. porter:azure:42): " OIDC_SUBJECT

        if [ -z "$OIDC_SUBJECT" ]; then
            print_error "OIDC subject is required"
            exit 1
        fi
    fi

    if [[ ! "$OIDC_SUBJECT" =~ ^porter:azure:[0-9]+$ ]]; then
        print_error "OIDC subject must be in the format porter:azure:<projectId> (e.g. porter:azure:42)"
        exit 1
    fi

    print_success "Using OIDC subject: $OIDC_SUBJECT"
}

# Function to enable resource providers
enable_resource_providers() {
    print_status "Enabling required resource providers..."

    providers=(
        "Microsoft.Capacity"
        "Microsoft.Compute"
        "Microsoft.ContainerRegistry"
        "Microsoft.ContainerService"
        "Microsoft.ManagedIdentity"
        "Microsoft.Network"
        "Microsoft.OperationalInsights"
        "Microsoft.OperationsManagement"
        "Microsoft.ResourceGraph"
        "Microsoft.Resources"
        "Microsoft.Storage"
    )

    for provider in "${providers[@]}"; do
        echo "  Registering $provider..."
        az provider register --namespace "$provider" --wait
    done

    print_success "Resource providers enabled"
}

# Function to create or update custom role
create_custom_role() {
    print_status "Managing custom porter-aks-restricted role..."

    # Create expected role definition
    cat > /tmp/porter-role-expected.json << EOF
{
    "assignableScopes": ["/subscriptions/${SUBSCRIPTION_ID}"],
    "description": "Grants Porter access to manage resources for an AKS cluster.",
    "name": "porter-aks-restricted",
    "permissions": [
        {
            "actions": ["*"],
            "dataActions": [],
            "notActions": [
                "Microsoft.Authorization/elevateAccess/Action",
                "Microsoft.Blueprint/blueprintAssignments/write",
                "Microsoft.Blueprint/blueprintAssignments/delete",
                "Microsoft.Compute/galleries/share/action"
            ],
            "notDataActions": []
        }
    ]
}
EOF

    # Check if role already exists
    if [ "$(az role definition list --name "porter-aks-restricted" --query "length(@)" -o tsv)" != "0" ]; then
        print_info "Role porter-aks-restricted already exists, checking if update is needed..."

        # Get existing role definition
        az role definition list --name "porter-aks-restricted" --output json > /tmp/porter-role-existing.json

        # Extract relevant fields for comparison (normalize the structure)
        jq -r '.[0] | {
            assignableScopes: .assignableScopes,
            description: .description,
            permissions: (.permissions | map({
                actions: .actions,
                dataActions: .dataActions,
                notActions: .notActions,
                notDataActions: .notDataActions
            }))
        }' /tmp/porter-role-existing.json > /tmp/porter-role-existing-normalized.json

        # Normalize expected role for comparison
        jq '{
            assignableScopes: .assignableScopes,
            description: .description,
            permissions: (.permissions | map({
                actions: .actions,
                dataActions: .dataActions,
                notActions: .notActions,
                notDataActions: .notDataActions
            }))
        }' /tmp/porter-role-expected.json > /tmp/porter-role-expected-normalized.json

        # Compare normalized definitions
        if cmp -s /tmp/porter-role-existing-normalized.json /tmp/porter-role-expected-normalized.json; then
            print_success "Role is up to date, no changes needed"
        else
            print_warning "Role definition has diverged, updating..."

            # Get the role ID (GUID) for update
            ROLE_ID=$(jq -r '.[0].id' /tmp/porter-role-existing.json)

            # Add the role ID to our expected definition for update
            jq --arg role_id "$ROLE_ID" '.id = $role_id' /tmp/porter-role-expected.json > /tmp/porter-role-update.json

            # Update the role
            if az role definition update --role-definition /tmp/porter-role-update.json; then
                print_success "Role updated successfully"
            else
                print_error "Failed to update role"
                exit 1
            fi

            rm /tmp/porter-role-update.json
        fi

        rm /tmp/porter-role-existing.json /tmp/porter-role-existing-normalized.json /tmp/porter-role-expected-normalized.json
    else
        print_info "Role does not exist, creating..."

        # Create the role
        if az role definition create --role-definition /tmp/porter-role-expected.json; then
            print_success "Custom role created"
        else
            print_error "Failed to create role"
            exit 1
        fi
    fi

    rm /tmp/porter-role-expected.json
}

# Function to create app registration and service principal
create_app_registration() {
    print_status "Creating app registration..."

    APP_OUTPUT=$(az ad app create --display-name "azure-porter-federated-sp")
    APP_ID=$(echo "$APP_OUTPUT" | jq -r '.appId')
    APP_OBJECT_ID=$(echo "$APP_OUTPUT" | jq -r '.id')

    if [ -z "$APP_ID" ] || [ "$APP_ID" = "null" ]; then
        print_error "Failed to create app registration"
        exit 1
    fi

    az ad sp create --id "$APP_ID" > /dev/null
    sleep 10

    az role assignment create \
        --assignee "$APP_ID" \
        --role "porter-aks-restricted" \
        --scope "/subscriptions/${SUBSCRIPTION_ID}" > /dev/null

    TENANT_ID=$(az account show --query tenantId -o tsv)

    print_success "App registration created"
}

# Function to add API permissions
add_api_permissions() {
    print_status "Adding Microsoft Graph API permissions..."

    # Microsoft Graph App ID (constant)
    MSGRAPH_APP_ID="00000003-0000-0000-c000-000000000000"

    # Required permission names
    required_permissions=(
        "Application.ReadWrite.All"
        "Directory.ReadWrite.All"
        "Domain.Read.All"
        "Group.Create"
        "Group.ReadWrite.All"
        "RoleManagement.ReadWrite.Directory"
        "User.ReadWrite.All"
    )

    # Get Microsoft Graph service principal to fetch permission IDs dynamically
    print_info "Fetching Microsoft Graph permission IDs..."
    msgraph_sp=$(az ad sp show --id "$MSGRAPH_APP_ID" --query "appRoles[?value != null].{value:value,id:id}" -o json)

    if [ "$msgraph_sp" = "null" ] || [ -z "$msgraph_sp" ]; then
        print_error "Failed to fetch Microsoft Graph service principal"
        exit 1
    fi

    # Get existing permissions to avoid duplicates
    existing_perms=$(az ad app permission list --id "$APP_ID" --query "[?resourceAppId=='$MSGRAPH_APP_ID'].resourceAccess[].id" -o tsv 2>/dev/null || echo "")

    # Process each required permission
    for perm_name in "${required_permissions[@]}"; do
        # Get permission ID dynamically
        perm_id=$(echo "$msgraph_sp" | jq -r ".[] | select(.value == \"$perm_name\") | .id")

        if [ -z "$perm_id" ] || [ "$perm_id" = "null" ]; then
            print_warning "Permission '$perm_name' not found in Microsoft Graph API"
            continue
        fi

        # Check if permission already exists
        if echo "$existing_perms" | grep -q "$perm_id"; then
            print_info "Permission '$perm_name' already exists, skipping"
            continue
        fi

        # Add the permission
        echo "  Adding $perm_name..."
        if az ad app permission add \
            --id "$APP_ID" \
            --api "$MSGRAPH_APP_ID" \
            --api-permissions "${perm_id}=Role"; then
            print_info "Successfully added $perm_name"
        else
            print_warning "Failed to add $perm_name"
        fi
    done

    # Wait for permissions to propagate
    print_info "Waiting for permissions to propagate..."
    sleep 5

    print_success "API permissions processed"
}

# Function to grant admin consent
grant_admin_consent() {
    print_status "Granting admin consent..."

    if ! az ad app permission admin-consent --id "$APP_ID"; then
        print_error "Failed to grant admin consent. You may need admin privileges on this Azure subscription."
        print_info "You can manually grant consent in Azure Portal: App registrations > $APP_ID > API permissions > Grant admin consent"
        return 1
    fi

    print_success "Admin consent granted"
}

# Function to create federated identity credential
create_federated_credential() {
    print_status "Creating federated identity credential..."

    PROJECT_ID="${OIDC_SUBJECT##*:}"
    FIC_NAME="porter-project-${PROJECT_ID}"

    az ad app federated-credential create \
        --id "$APP_OBJECT_ID" \
        --parameters "{
            \"name\": \"${FIC_NAME}\",
            \"issuer\": \"https://oidc.porter.run\",
            \"subject\": \"${OIDC_SUBJECT}\",
            \"audiences\": [\"api://AzureADTokenExchange\"]
        }" > /dev/null

    print_success "Federated identity credential created"
}

# Function to display results
display_results() {
    echo ""
    print_success "Setup completed! Use these credentials in Porter:"
    echo ""
    echo "┌─────────────────────────────────────────────────────────────┐"
    echo "│                    AZURE CREDENTIALS                        │"
    echo "├─────────────────────────────────────────────────────────────┤"
    printf "│ Subscription ID: %-43s │\n" "$SUBSCRIPTION_ID"
    printf "│ Client ID:       %-43s │\n" "$APP_ID"
    printf "│ Tenant ID:       %-43s │\n" "$TENANT_ID"
    echo "└─────────────────────────────────────────────────────────────┘"
    echo ""

    print_info "Next steps:"
    echo "1. Copy the above credentials to Porter dashboard"
    echo "2. Request quota increases if needed:"
    echo "   - Total Regional vCPUs: 40"
    echo "   - Standard Basv2 Family vCPUs: 40"
    echo "   Go to: Azure Portal > Subscriptions > Usage + quotas"
    echo "3. Proceed with cluster provisioning in Porter"
}

# Function to show usage
show_usage() {
    echo "Usage: $0 [SUBSCRIPTION_ID] [OIDC_SUBJECT]"
    echo ""
    echo "  SUBSCRIPTION_ID  Optional: Azure subscription ID to use"
    echo "                   If not provided, you'll be prompted to select one"
    echo "  OIDC_SUBJECT     Porter OIDC subject (e.g. porter:azure:42)"
    echo "                   Copy this from Porter during the Azure cloud account connection steps"
    echo ""
    echo "Example:"
    echo "  $0 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx porter:azure:42"
    echo ""
}

# Main execution
main() {
    # Show help if requested
    if [[ "$1" == "-h" || "$1" == "--help" ]]; then
        show_usage
        exit 0
    fi

    echo -e "${GREEN}Starting Azure Workload Identity Federation setup for Porter...${NC}"
    echo ""

    # Check if jq is installed
    if ! command -v jq &> /dev/null; then
        print_error "jq is required but not installed. Please install jq first:"
        echo "  macOS: brew install jq"
        echo "  Ubuntu/Debian: sudo apt-get install jq"
        echo "  CentOS/RHEL: sudo yum install jq"
        exit 1
    fi

    check_prerequisites
    get_subscription_id "$1"
    get_oidc_subject "$2"
    enable_resource_providers
    create_custom_role
    create_app_registration
    add_api_permissions

    # Try to grant admin consent, but don't fail if it doesn't work
    if ! grant_admin_consent; then
        print_warning "Admin consent failed - you may need to grant it manually in Azure Portal"
    fi

    create_federated_credential
    display_results

    echo ""
    print_success "Azure WIF setup completed successfully!"
}

# Run main function
main "$@"

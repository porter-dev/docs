#!/bin/bash

# Porter GCP Setup Script
# Creates a service account with the Project IAM Admin role and enables the
# Cloud Resource Manager API. Porter automatically provisions all other
# required permissions and APIs from this bootstrap role.

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_status() { echo -e "${BLUE}$1${NC}"; }
print_success() { echo -e "${GREEN}$1${NC}"; }
print_warning() { echo -e "${YELLOW}$1${NC}"; }
print_error() { echo -e "${RED}$1${NC}"; }

SERVICE_ACCOUNT_NAME="${PORTER_SA_NAME:-porter-manager}"

show_usage() {
    echo "Usage: $0 [PROJECT_ID]"
    echo ""
    echo "  PROJECT_ID  Optional: GCP project ID to use"
    echo "              If not provided, the active gcloud project is used"
    echo ""
    echo "Environment variables:"
    echo "  PORTER_SA_NAME  Service account name (default: porter-manager)"
    echo ""
    echo "Examples:"
    echo "  $0 my-gcp-project"
    echo "  PORTER_SA_NAME=custom-name $0 my-gcp-project"
    echo ""
}

check_prerequisites() {
    print_status "Checking prerequisites..."

    if ! command -v gcloud &> /dev/null; then
        print_error "gcloud CLI not found. Install it from https://cloud.google.com/sdk/docs/install"
        exit 1
    fi

    if ! gcloud auth list --filter="status:ACTIVE" --format="value(account)" 2>/dev/null | grep -q .; then
        print_error "Not logged in to gcloud. Please run 'gcloud auth login' first."
        exit 1
    fi

    print_success "Prerequisites check passed"
}

get_project_id() {
    if [ -n "$1" ]; then
        PROJECT_ID="$1"
    else
        PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
        if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "(unset)" ]; then
            print_error "No project ID provided and no active gcloud project set."
            echo "Either pass a project ID as an argument or run: gcloud config set project PROJECT_ID"
            exit 1
        fi
    fi

    # Validate project is accessible
    if ! gcloud projects describe "$PROJECT_ID" &> /dev/null; then
        print_error "Project '$PROJECT_ID' not found or not accessible."
        exit 1
    fi

    print_success "Using project: $PROJECT_ID"
}

enable_cloud_resource_manager_api() {
    print_status "Enabling Cloud Resource Manager API..."
    gcloud services enable cloudresourcemanager.googleapis.com --project="$PROJECT_ID"
    print_success "Cloud Resource Manager API enabled"
}

create_service_account() {
    local sa_email="${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

    # Check if service account already exists
    if gcloud iam service-accounts describe "$sa_email" --project="$PROJECT_ID" &> /dev/null; then
        print_warning "Service account $sa_email already exists, skipping creation"
    else
        print_status "Creating service account..."
        gcloud iam service-accounts create "$SERVICE_ACCOUNT_NAME" \
            --display-name="Porter Service Account" \
            --project="$PROJECT_ID"
        print_success "Service account created: $sa_email"
    fi

    SA_EMAIL="$sa_email"
}

grant_iam_role() {
    print_status "Granting Project IAM Admin role..."

    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:${SA_EMAIL}" \
        --role="roles/resourcemanager.projectIamAdmin" \
        --condition=None \
        --quiet > /dev/null

    print_success "Project IAM Admin role granted"
}

create_key() {
    KEY_FILE="porter-sa-key-${PROJECT_ID}.json"

    print_status "Creating service account key..."
    gcloud iam service-accounts keys create "$KEY_FILE" \
        --iam-account="$SA_EMAIL" \
        --project="$PROJECT_ID"

    print_success "Key saved to: $KEY_FILE"
}

display_results() {
    echo ""
    print_success "========================================="
    print_success "  GCP setup for Porter is complete!"
    print_success "========================================="
    echo ""
    echo "  Project:          $PROJECT_ID"
    echo "  Service Account:  $SA_EMAIL"
    echo "  Key File:         $KEY_FILE"
    echo ""
    echo "Next steps:"
    echo "  1. Go to the Porter dashboard"
    echo "  2. Select GCP as your cloud provider"
    echo "  3. Upload the key file: $KEY_FILE"
    echo "  4. Porter will automatically provision all remaining permissions and APIs"
    echo ""
    print_warning "Keep $KEY_FILE safe — it grants access to your GCP project."
    print_warning "Do not commit it to version control."
}

main() {
    if [[ "$1" == "-h" || "$1" == "--help" ]]; then
        show_usage
        exit 0
    fi

    echo -e "${GREEN}Starting GCP setup for Porter...${NC}"
    echo ""

    check_prerequisites
    get_project_id "$1"
    enable_cloud_resource_manager_api
    create_service_account
    grant_iam_role
    create_key
    display_results
}

main "$@"

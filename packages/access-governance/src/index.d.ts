import { GovernanceProvider, GovernanceAuthority, GovernanceSubject, GovernedEntitlement, GovernedAccessRequest, GovernanceRequest, GovernanceRequestStatus, GovernanceAssignment, GovernanceRevocationResult, AccessRequest, EntitlementRef, ExternalIdentity, ReconciliationResult, GovernanceReconciler, GovernanceReconcilerConfig } from "@opnory/access-types";
import { InMemoryApprovalStore, ApprovalService } from "@opnory/access-approval";
import { AuditEventStore } from "@opnory/access-audit";
export declare class LocalGovernanceProvider implements GovernanceProvider {
    readonly authority: GovernanceAuthority;
    approvalStore: InMemoryApprovalStore;
    auditStore: AuditEventStore;
    approvalService: ApprovalService;
    constructor(approvalStore?: InMemoryApprovalStore, auditStore?: AuditEventStore);
    resolveSubject(identity: {
        requesterId: string;
        requesterEmail: string;
        externalIdentities: ExternalIdentity;
    }): Promise<GovernanceSubject>;
    resolveEntitlement(entitlement: EntitlementRef): Promise<GovernedEntitlement>;
    submitRequest(request: GovernedAccessRequest): Promise<GovernanceRequest>;
    getRequestStatus(externalRequestId: string): Promise<GovernanceRequestStatus>;
    getAssignment(subject: GovernanceSubject, entitlement: GovernedEntitlement): Promise<GovernanceAssignment | null>;
    revokeAssignment(assignment: GovernanceAssignment): Promise<GovernanceRevocationResult>;
}
export interface EntraConfig {
    tenantId: string;
    clientId: string;
    clientSecret: string;
}
export declare class EntraGovernanceProvider implements GovernanceProvider {
    readonly authority: GovernanceAuthority;
    private config;
    private accessToken;
    private tokenExpiresAt;
    constructor(config: EntraConfig);
    private getAccessToken;
    private graphRequest;
    resolveSubject(identity: {
        requesterId: string;
        requesterEmail: string;
        externalIdentities: ExternalIdentity;
    }): Promise<GovernanceSubject>;
    resolveEntitlement(entitlement: EntitlementRef): Promise<GovernedEntitlement>;
    submitRequest(request: GovernedAccessRequest): Promise<GovernanceRequest>;
    getRequestStatus(externalRequestId: string): Promise<GovernanceRequestStatus>;
    getAssignment(subject: GovernanceSubject, entitlement: GovernedEntitlement): Promise<GovernanceAssignment | null>;
    revokeAssignment(assignment: GovernanceAssignment): Promise<GovernanceRevocationResult>;
    private mapEntraStatus;
    private mapEntraAssignmentStatus;
    private parseDuration;
}
export interface OktaConfig {
    orgUrl: string;
    clientId: string;
    privateKey: string;
    keyId: string;
    requestConditionId?: string;
    scopes?: string[];
}
export declare class OktaGovernanceProvider implements GovernanceProvider {
    readonly authority: GovernanceAuthority;
    private config;
    private accessToken;
    private tokenExpiresAt;
    private testTokenProvider?;
    constructor(config: OktaConfig);
    __setTestTokenProvider(fn: () => Promise<string>): void;
    private getAccessToken;
    private generateJwtAssertion;
    clearTokenCache(): void;
    private oktaRequest;
    resolveSubject(identity: {
        requesterId: string;
        requesterEmail: string;
        externalIdentities: ExternalIdentity;
    }): Promise<GovernanceSubject>;
    resolveEntitlement(entitlement: EntitlementRef): Promise<GovernedEntitlement>;
    submitRequest(request: GovernedAccessRequest): Promise<GovernanceRequest>;
    getRequestStatus(externalRequestId: string): Promise<GovernanceRequestStatus>;
    getAssignment(subject: GovernanceSubject, entitlement: GovernedEntitlement): Promise<GovernanceAssignment | null>;
    revokeAssignment(assignment: GovernanceAssignment): Promise<GovernanceRevocationResult>;
    private mapOktaRequestStatus;
}
export interface GovernanceProviderFactoryConfig {
    entra?: EntraConfig;
    okta?: OktaConfig;
}
export declare function createGovernanceProvider(authority: GovernanceAuthority, config?: GovernanceProviderFactoryConfig): GovernanceProvider;
export declare class GovernanceService {
    private localProvider;
    private entraProvider?;
    private oktaProvider?;
    private providers;
    private auditStore;
    constructor(localProvider: LocalGovernanceProvider, entraProvider?: GovernanceProvider | undefined, oktaProvider?: GovernanceProvider | undefined, auditStore?: AuditEventStore);
    private getProvider;
    submitGovernedRequest(request: AccessRequest, entitlement: EntitlementRef, correlationId: string): Promise<GovernanceRequest>;
    checkGovernanceStatus(request: AccessRequest): Promise<GovernanceRequestStatus>;
    reconcileGovernance(request: AccessRequest): Promise<void>;
}
export declare class GovernanceReconcilerImpl implements GovernanceReconciler {
    private governanceService;
    private config;
    private auditStore;
    private approvalStore;
    constructor(governanceService: GovernanceService, config?: Partial<GovernanceReconcilerConfig>, auditStore?: AuditEventStore, approvalStore?: InMemoryApprovalStore);
    private recordReconciliationAudit;
    private getPendingRequests;
    private getActiveAssignments;
    private getPendingRevocations;
    reconcilePendingRequests(): Promise<ReconciliationResult>;
    reconcileAssignments(): Promise<ReconciliationResult>;
    reconcileRevocations(): Promise<ReconciliationResult>;
}
//# sourceMappingURL=index.d.ts.map
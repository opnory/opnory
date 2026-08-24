import { GovernanceProvider, GovernanceAuthority } from "@opnory/access-types";
export interface ProviderFactory {
    createProvider(): GovernanceProvider;
    providerName: string;
    providerAuthority: GovernanceAuthority;
}
export declare function describeGovernanceProvider(factory: ProviderFactory): void;
export declare const localProviderFactory: ProviderFactory;
export declare function createFakeEntraProviderFactory(): ProviderFactory;
export declare function createFakeOktaProviderFactory(): ProviderFactory;
//# sourceMappingURL=governance-provider-conformance.test.d.ts.map
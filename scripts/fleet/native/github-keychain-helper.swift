import CryptoKit
import Darwin
import Foundation
import LocalAuthentication
import Security

@_silgen_name("ptrace")
private func seoriPtrace(
  _ request: Int32,
  _ pid: pid_t,
  _ address: UnsafeMutableRawPointer?,
  _ data: Int32
) -> Int32

private let denyAttachRequest: Int32 = 31
private let adHocCodeSignatureFlag: UInt32 = 0x0002

private let helperName = "seorilabs-github-keychain"
private let helperIdentifier = "com.seorilabs.fleet.github-keychain-helper"
private let protocolName = "binary-stdin-v1"
private let aclPolicyName = "self-designated-requirement-no-prompt-v1"
private let frameMagic = Data("SEORIKC1".utf8)
private let frameVersion: UInt8 = 1
private let maximumInputBytes = 256 * 1024
private let privateKeyCredentialId = "shared/github/backoffice-app-private-key"
private let privateKeyService = "com.seorilabs.github.backoffice-app-private-key"
private let webhookCredentialId = "shared/github/backoffice-app-webhook"
private let webhookService = "com.seorilabs.github.backoffice-app-webhook"

private struct PublicFailure: Error {
  let code: String
  let compensationRequired: Bool
  let compensationVerified: Bool

  init(_ code: String, compensationRequired: Bool = false, compensationVerified: Bool = true) {
    self.code = code
    self.compensationRequired = compensationRequired
    self.compensationVerified = compensationVerified
  }
}

private struct Target: Equatable {
  let credentialId: String
  let service: String

  var publicObject: [String: Any] {
    ["credentialId": credentialId, "service": service]
  }
}

private let allowedTargets = [
  Target(credentialId: privateKeyCredentialId, service: privateKeyService),
  Target(credentialId: webhookCredentialId, service: webhookService),
]

private struct RequestItem {
  let target: Target
  var secret: Data

  mutating func zeroize() {
    secret.resetBytes(in: 0..<secret.count)
  }
}

private struct BatchRequest {
  let operation: UInt8
  var items: [RequestItem]

  mutating func zeroize() {
    for index in items.indices {
      items[index].zeroize()
    }
  }
}

private struct FrameCursor {
  var bytes: Data
  var offset = 0

  mutating func zeroize() {
    bytes.resetBytes(in: 0..<bytes.count)
  }

  mutating func readByte() throws -> UInt8 {
    guard offset < bytes.count else { throw PublicFailure("FRAME_INVALID") }
    defer { offset += 1 }
    return bytes[offset]
  }

  mutating func readUInt16() throws -> Int {
    let high = Int(try readByte())
    let low = Int(try readByte())
    return (high << 8) | low
  }

  mutating func readUInt32() throws -> Int {
    var value: UInt32 = 0
    for _ in 0..<4 {
      value = (value << 8) | UInt32(try readByte())
    }
    guard value <= UInt32(Int.max) else { throw PublicFailure("FRAME_INVALID") }
    return Int(value)
  }

  mutating func readData(length: Int) throws -> Data {
    guard length >= 0, offset <= bytes.count, length <= bytes.count - offset else {
      throw PublicFailure("FRAME_INVALID")
    }
    let result = Data(bytes[offset..<(offset + length)])
    offset += length
    return result
  }

  mutating func readString(length: Int) throws -> String {
    guard length > 0, length <= 255 else { throw PublicFailure("FRAME_INVALID") }
    let value = try readData(length: length)
    guard let result = String(data: value, encoding: .utf8), !result.contains("\0") else {
      throw PublicFailure("FRAME_INVALID")
    }
    return result
  }
}

private func sha256Hex(_ value: Data) -> String {
  SHA256.hash(data: value).map { String(format: "%02x", $0) }.joined()
}

private func canonicalTargetSetDigest() -> String {
  let canonical =
    allowedTargets
    .map { "\($0.credentialId)\0\($0.service)" }
    .joined(separator: "\0")
  return sha256Hex(Data(canonical.utf8))
}

private func readRequest(expectedOperation: UInt8, includesSecrets: Bool) throws -> BatchRequest {
  var input = FileHandle.standardInput.readDataToEndOfFile()
  defer { input.resetBytes(in: 0..<input.count) }
  guard input.count <= maximumInputBytes else { throw PublicFailure("FRAME_TOO_LARGE") }
  var cursor = FrameCursor(bytes: input)
  defer { cursor.zeroize() }
  guard try cursor.readData(length: frameMagic.count) == frameMagic,
    try cursor.readByte() == frameVersion,
    try cursor.readByte() == expectedOperation,
    try cursor.readByte() == UInt8(allowedTargets.count),
    try cursor.readByte() == 0
  else {
    throw PublicFailure("FRAME_INVALID")
  }

  var items: [RequestItem] = []
  do {
    for expected in allowedTargets {
      let credentialIdLength = try cursor.readUInt16()
      let serviceLength = try cursor.readUInt16()
      let secretLength = try cursor.readUInt32()
      let target = Target(
        credentialId: try cursor.readString(length: credentialIdLength),
        service: try cursor.readString(length: serviceLength)
      )
      guard target == expected else { throw PublicFailure("TARGET_SET_MISMATCH") }
      if includesSecrets {
        let allowedLength =
          target.credentialId == privateKeyCredentialId
          ? (256...32_768).contains(secretLength)
          : (32...4_096).contains(secretLength)
        guard allowedLength else { throw PublicFailure("SECRET_LENGTH_INVALID") }
      } else if secretLength != 0 {
        throw PublicFailure("FRAME_INVALID")
      }
      items.append(RequestItem(target: target, secret: try cursor.readData(length: secretLength)))
    }
    guard cursor.offset == input.count else { throw PublicFailure("FRAME_INVALID") }
    return BatchRequest(operation: expectedOperation, items: items)
  } catch {
    for index in items.indices { items[index].zeroize() }
    throw error
  }
}

private func hardenProcess() throws {
  var coreLimit = rlimit(rlim_cur: 0, rlim_max: 0)
  guard setrlimit(RLIMIT_CORE, &coreLimit) == 0 else {
    throw PublicFailure("PROCESS_HARDENING_FAILED")
  }
  guard seoriPtrace(denyAttachRequest, 0, nil, 0) == 0 else {
    throw PublicFailure("PROCESS_HARDENING_FAILED")
  }
  _ = umask(0o077)
  unsetenv("DYLD_INSERT_LIBRARIES")
  unsetenv("DYLD_LIBRARY_PATH")
  unsetenv("MallocStackLogging")
  unsetenv("NSUnbufferedIO")
}

private func emit(_ value: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(value),
    let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  else {
    _exit(70)
  }
  FileHandle.standardOutput.write(bytes)
  FileHandle.standardOutput.write(Data([0x0A]))
}

private func failAndExit(_ failure: PublicFailure, operation: String) -> Never {
  emit([
    "schemaVersion": 1,
    "state": "DENIED",
    "operation": operation,
    "code": failure.code,
    "compensation": [
      "required": failure.compensationRequired,
      "verified": failure.compensationVerified,
    ],
  ])
  _exit(70)
}

private struct CodeIdentity {
  let teamIdentifier: String
  let requirementDigest: String

  var publicObject: [String: Any] {
    [
      "identifier": helperIdentifier,
      "teamIdentifier": teamIdentifier,
      "designatedRequirementSha256": requirementDigest,
      "signed": true,
      "adHoc": false,
    ]
  }
}

private func expectedRequirementString() -> String {
  "identifier \"\(helperIdentifier)\" and anchor apple generic and certificate leaf[subject.OU] = \"\(SeoriKeychainBuildIdentity.expectedTeamIdentifier)\""
}

private func verifyCodeIdentity() throws -> CodeIdentity {
  #if SEORI_KEYCHAIN_FIXTURE
    return CodeIdentity(
      teamIdentifier: SeoriKeychainBuildIdentity.expectedTeamIdentifier,
      requirementDigest: sha256Hex(Data(expectedRequirementString().utf8))
    )
  #else
    var currentCode: SecCode?
    guard SecCodeCopySelf([], &currentCode) == errSecSuccess, let currentCode else {
      throw PublicFailure("CODE_IDENTITY_UNTRUSTED")
    }
    let requirementText = expectedRequirementString() as CFString
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(requirementText, [], &requirement) == errSecSuccess,
      let requirement,
      SecCodeCheckValidity(currentCode, SecCSFlags(rawValue: kSecCSStrictValidate), requirement)
        == errSecSuccess
    else {
      throw PublicFailure("CODE_IDENTITY_UNTRUSTED")
    }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(currentCode, [], &staticCode) == errSecSuccess,
      let staticCode
    else {
      throw PublicFailure("CODE_IDENTITY_UNTRUSTED")
    }
    var signingInformation: CFDictionary?
    guard
      SecCodeCopySigningInformation(
        staticCode,
        SecCSFlags(rawValue: kSecCSSigningInformation),
        &signingInformation
      ) == errSecSuccess,
      let information = signingInformation as? [CFString: Any],
      information[kSecCodeInfoIdentifier] as? String == helperIdentifier,
      information[kSecCodeInfoTeamIdentifier] as? String
        == SeoriKeychainBuildIdentity.expectedTeamIdentifier,
      let flags = information[kSecCodeInfoFlags] as? NSNumber,
      (flags.uint32Value & adHocCodeSignatureFlag) == 0
    else {
      throw PublicFailure("CODE_IDENTITY_UNTRUSTED")
    }
    return CodeIdentity(
      teamIdentifier: SeoriKeychainBuildIdentity.expectedTeamIdentifier,
      requirementDigest: sha256Hex(Data((requirementText as String).utf8))
    )
  #endif
}

private enum LookupResult {
  case notFound
  case present
}

private protocol KeychainBackend: AnyObject {
  func lookup(_ target: Target, expectedSecret: Data?) throws -> LookupResult
  func add(_ target: Target, secret: Data) throws
  func delete(_ target: Target) throws
}

private func nonInteractiveContext() -> LAContext {
  let context = LAContext()
  context.interactionNotAllowed = true
  return context
}

private func publicKeychainFailure(_ status: OSStatus) -> PublicFailure {
  switch status {
  case errSecItemNotFound:
    return PublicFailure("ITEM_NOT_FOUND")
  case errSecDuplicateItem:
    return PublicFailure("ITEM_ALREADY_EXISTS")
  case errSecInteractionNotAllowed:
    return PublicFailure("KEYCHAIN_LOCKED_OR_UI_REQUIRED")
  case errSecAuthFailed:
    return PublicFailure("ACL_PERMISSION_DENIED")
  case errSecUserCanceled:
    return PublicFailure("AUTHENTICATION_UI_BLOCKED")
  case errSecNotAvailable:
    return PublicFailure("KEYCHAIN_UNAVAILABLE")
  default:
    return PublicFailure("KEYCHAIN_OPERATION_FAILED")
  }
}

private final class SecurityKeychainBackend: KeychainBackend {
  private let expectedTrustedApplicationData: Data

  init() throws {
    var trustedApplication: SecTrustedApplication?
    guard SecTrustedApplicationCreateFromPath(nil, &trustedApplication) == errSecSuccess,
      let trustedApplication
    else {
      throw PublicFailure("ACL_POLICY_UNAVAILABLE")
    }
    var applicationData: CFData?
    guard SecTrustedApplicationCopyData(trustedApplication, &applicationData) == errSecSuccess,
      let applicationData
    else {
      throw PublicFailure("ACL_POLICY_UNAVAILABLE")
    }
    expectedTrustedApplicationData = applicationData as Data
  }

  private func query(
    _ target: Target,
    readback: Bool,
    returnData: Bool = false,
    synchronizable: Any = kSecAttrSynchronizableAny
  ) -> [CFString: Any] {
    var query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: target.service,
      kSecAttrAccount: target.credentialId,
      kSecAttrSynchronizable: synchronizable,
      kSecMatchLimit: kSecMatchLimitOne,
      kSecUseAuthenticationContext: nonInteractiveContext(),
    ]
    if readback {
      query[kSecReturnAttributes] = true
    }
    if returnData {
      query[kSecReturnData] = true
    }
    return query
  }

  private func accessForSelf(_ target: Target) throws -> SecAccess {
    var trustedApplication: SecTrustedApplication?
    guard SecTrustedApplicationCreateFromPath(nil, &trustedApplication) == errSecSuccess,
      let trustedApplication
    else {
      throw PublicFailure("ACL_POLICY_UNAVAILABLE")
    }
    let applications = [trustedApplication] as CFArray
    var access: SecAccess?
    guard
      SecAccessCreate(
        "Seorilabs Fleet \(target.credentialId)" as CFString,
        applications,
        &access
      ) == errSecSuccess, let access
    else {
      throw PublicFailure("ACL_POLICY_UNAVAILABLE")
    }
    try verifyAccess(access, target: target)
    return access
  }

  private func verifyAccess(_ access: SecAccess, target: Target) throws {
    var aclList: CFArray?
    guard SecAccessCopyACLList(access, &aclList) == errSecSuccess,
      let acls = aclList as? [SecACL], !acls.isEmpty
    else {
      throw PublicFailure("ACL_READBACK_MISMATCH")
    }
    let anyAuthorization = kSecACLAuthorizationAny as String
    let requiredAuthorizations = Set([
      kSecACLAuthorizationDecrypt as String,
      kSecACLAuthorizationDelete as String,
      kSecACLAuthorizationExportClear as String,
      kSecACLAuthorizationChangeACL as String,
    ])
    let sensitiveAuthorizations = requiredAuthorizations.union([anyAuthorization])
    var coveredAuthorizations = Set<String>()
    var anyAuthorizationCovered = false
    let expectedDescription = "Seorilabs Fleet \(target.credentialId)"
    for acl in acls {
      guard let authorizations = SecACLCopyAuthorizations(acl) as? [String] else {
        throw PublicFailure("ACL_READBACK_MISMATCH")
      }
      let sensitive = Set(authorizations).intersection(sensitiveAuthorizations)
      if sensitive.isEmpty { continue }
      var applications: CFArray?
      var description: CFString?
      var selector: SecKeychainPromptSelector = []
      guard SecACLCopyContents(acl, &applications, &description, &selector) == errSecSuccess else {
        throw PublicFailure("ACL_READBACK_MISMATCH")
      }
      guard selector.isEmpty,
        description as String? == expectedDescription,
        let trustedApplications = applications as? [SecTrustedApplication],
        trustedApplications.count == 1
      else {
        throw PublicFailure("ACL_READBACK_MISMATCH")
      }
      var applicationData: CFData?
      guard
        SecTrustedApplicationCopyData(trustedApplications[0], &applicationData) == errSecSuccess,
        let applicationData,
        applicationData as Data == expectedTrustedApplicationData
      else {
        throw PublicFailure("ACL_READBACK_MISMATCH")
      }
      if sensitive.contains(anyAuthorization) { anyAuthorizationCovered = true }
      coveredAuthorizations.formUnion(sensitive)
    }
    guard anyAuthorizationCovered || requiredAuthorizations.isSubset(of: coveredAuthorizations)
    else {
      throw PublicFailure("ACL_READBACK_MISMATCH")
    }
  }

  func lookup(_ target: Target, expectedSecret: Data?) throws -> LookupResult {
    var result: CFTypeRef?
    let returnData = expectedSecret != nil
    let status = SecItemCopyMatching(
      query(target, readback: true, returnData: returnData) as CFDictionary,
      &result
    )
    if status == errSecItemNotFound { return .notFound }
    guard status == errSecSuccess,
      let dictionary = result as? [CFString: Any],
      dictionary[kSecAttrService] as? String == target.service,
      dictionary[kSecAttrAccount] as? String == target.credentialId,
      dictionary[kSecAttrLabel] as? String == "Seorilabs Fleet GitHub credential",
      dictionary[kSecAttrDescription] as? String
        == "Managed by signed Seorilabs GitHub Keychain helper",
      dictionary[kSecAttrSynchronizable] as? Bool != true,
      let rawAccess = dictionary[kSecAttrAccess],
      CFGetTypeID(rawAccess as CFTypeRef) == SecAccessGetTypeID()
    else {
      if status != errSecSuccess { throw publicKeychainFailure(status) }
      throw PublicFailure("KEYCHAIN_READBACK_MISMATCH")
    }
    let access = unsafeBitCast(rawAccess as CFTypeRef, to: SecAccess.self)
    try verifyAccess(access, target: target)
    if let expectedSecret {
      guard let data = dictionary[kSecValueData] as? Data,
        data.elementsEqual(expectedSecret)
      else {
        throw PublicFailure("KEYCHAIN_READBACK_MISMATCH")
      }
    }
    return .present
  }

  func add(_ target: Target, secret: Data) throws {
    let access = try accessForSelf(target)
    let attributes: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: target.service,
      kSecAttrAccount: target.credentialId,
      kSecAttrLabel: "Seorilabs Fleet GitHub credential",
      kSecAttrDescription: "Managed by signed Seorilabs GitHub Keychain helper",
      kSecAttrSynchronizable: false,
      kSecAttrAccess: access,
      kSecValueData: secret,
      kSecUseAuthenticationContext: nonInteractiveContext(),
    ]
    let status = SecItemAdd(attributes as CFDictionary, nil)
    guard status == errSecSuccess else { throw publicKeychainFailure(status) }
  }

  func delete(_ target: Target) throws {
    let status = SecItemDelete(
      query(target, readback: false, synchronizable: false) as CFDictionary
    )
    guard status == errSecSuccess else { throw publicKeychainFailure(status) }
  }
}

#if SEORI_KEYCHAIN_FIXTURE
  private final class FixtureKeychainBackend: KeychainBackend {
    private var entries: [String: Data] = [:]
    private var addCount = 0
    var failSecondAdd = false
    var deleteFails = false

    func lookup(_ target: Target, expectedSecret: Data?) throws -> LookupResult {
      guard let stored = entries[target.credentialId] else { return .notFound }
      if let expectedSecret, !stored.elementsEqual(expectedSecret) {
        throw PublicFailure("KEYCHAIN_READBACK_MISMATCH")
      }
      return .present
    }

    func add(_ target: Target, secret: Data) throws {
      addCount += 1
      if failSecondAdd && addCount == 2 { throw PublicFailure("FIXTURE_ADD_FAILED") }
      guard entries[target.credentialId] == nil else { throw PublicFailure("ITEM_ALREADY_EXISTS") }
      entries[target.credentialId] = Data(secret)
    }

    func delete(_ target: Target) throws {
      if deleteFails { throw PublicFailure("FIXTURE_DELETE_FAILED") }
      guard entries.removeValue(forKey: target.credentialId) != nil else {
        throw PublicFailure("ITEM_NOT_FOUND")
      }
    }
  }
#endif

private func requireAbsent(_ backend: KeychainBackend, targets: [Target]) throws {
  for target in targets {
    switch try backend.lookup(target, expectedSecret: nil) {
    case .notFound:
      continue
    case .present:
      throw PublicFailure("ITEM_ALREADY_EXISTS")
    }
  }
}

private func writeBatch(_ backend: KeychainBackend, items: [RequestItem]) throws {
  try requireAbsent(backend, targets: items.map(\.target))
  var created: [Target] = []
  do {
    for item in items {
      try backend.add(item.target, secret: item.secret)
      created.append(item.target)
      guard case .present = try backend.lookup(item.target, expectedSecret: item.secret) else {
        throw PublicFailure("KEYCHAIN_READBACK_MISMATCH")
      }
    }
  } catch let original {
    var compensationVerified = true
    for target in created.reversed() {
      do {
        try backend.delete(target)
        guard case .notFound = try backend.lookup(target, expectedSecret: nil) else {
          compensationVerified = false
          continue
        }
      } catch {
        compensationVerified = false
      }
    }
    let code = (original as? PublicFailure)?.code ?? "KEYCHAIN_OPERATION_FAILED"
    throw PublicFailure(
      code,
      compensationRequired: !created.isEmpty,
      compensationVerified: compensationVerified
    )
  }
}

private func removeBatch(_ backend: KeychainBackend, targets: [Target]) throws {
  for target in targets {
    guard case .present = try backend.lookup(target, expectedSecret: nil) else {
      throw PublicFailure("ITEM_NOT_FOUND")
    }
  }
  var removalFailed = false
  for target in targets.reversed() {
    do {
      try backend.delete(target)
      guard case .notFound = try backend.lookup(target, expectedSecret: nil) else {
        removalFailed = true
        continue
      }
    } catch {
      removalFailed = true
    }
  }
  if removalFailed {
    throw PublicFailure(
      "BATCH_COMPENSATION_FAILED", compensationRequired: true, compensationVerified: false)
  }
}

private func success(operation: String, targets: [Target], compensationRequired: Bool = false) {
  emit([
    "schemaVersion": 1,
    "state": "VERIFIED",
    "operation": operation,
    "targets": targets.map { $0.publicObject.merging(["state": "VERIFIED"]) { _, new in new } },
    "readback": ["unattendedAclExact": true, "withoutPrompt": true],
    "compensation": ["required": compensationRequired, "verified": true],
  ])
}

private func attest() throws {
  let identity = try verifyCodeIdentity()
  emit([
    "schemaVersion": 1,
    "state": SeoriKeychainBuildIdentity.fixture ? "FIXTURE" : "VERIFIED",
    "helper": helperName,
    "codeIdentity": identity.publicObject,
    "policy": [
      "protocol": protocolName,
      "targetSetSha256": canonicalTargetSetDigest(),
      "unattendedAcl": aclPolicyName,
      "authenticationUI": "fail",
    ],
  ])
}

#if SEORI_KEYCHAIN_FIXTURE
  private func fixtureSelfTest() throws {
    var secrets = [Data(repeating: 0x41, count: 512), Data(repeating: 0x42, count: 48)]
    defer {
      for index in secrets.indices { secrets[index].resetBytes(in: 0..<secrets[index].count) }
    }
    let items = zip(allowedTargets, secrets).map { RequestItem(target: $0.0, secret: $0.1) }
    let itemNotFoundBackend = FixtureKeychainBackend()
    try requireAbsent(itemNotFoundBackend, targets: allowedTargets)

    let compensatedBackend = FixtureKeychainBackend()
    compensatedBackend.failSecondAdd = true
    do {
      try writeBatch(compensatedBackend, items: items)
      throw PublicFailure("FIXTURE_EXPECTED_FAILURE_MISSING")
    } catch let failure as PublicFailure {
      guard failure.code == "FIXTURE_ADD_FAILED",
        failure.compensationRequired,
        failure.compensationVerified,
        case .notFound = try compensatedBackend.lookup(allowedTargets[0], expectedSecret: nil)
      else {
        throw PublicFailure("FIXTURE_COMPENSATION_UNVERIFIED")
      }
    }

    emit([
      "schemaVersion": 1,
      "state": "FIXTURE_VERIFIED",
      "itemNotFoundExact": true,
      "batchCompensationVerified": true,
      "fixtureOnly": true,
    ])
  }
#endif

@main
private enum GithubKeychainHelperMain {
  static func main() {
    do {
      try hardenProcess()
      guard CommandLine.arguments.count == 2 else { throw PublicFailure("COMMAND_INVALID") }
      let command = CommandLine.arguments[1]
      if command == "attest" {
        try attest()
        return
      }
      #if SEORI_KEYCHAIN_FIXTURE
        if command == "fixture-self-test" {
          try fixtureSelfTest()
          return
        }
      #endif
      _ = try verifyCodeIdentity()
      let backend: KeychainBackend = try SecurityKeychainBackend()
      if command == "preflight" {
        var request = try readRequest(expectedOperation: 0, includesSecrets: false)
        defer { request.zeroize() }
        try requireAbsent(backend, targets: request.items.map(\.target))
        success(operation: "PREFLIGHT", targets: request.items.map(\.target))
      } else if command == "write-batch" {
        var request = try readRequest(expectedOperation: 1, includesSecrets: true)
        defer { request.zeroize() }
        try writeBatch(backend, items: request.items)
        success(operation: "WRITE_BATCH", targets: request.items.map(\.target))
      } else if command == "remove-batch" {
        var request = try readRequest(expectedOperation: 2, includesSecrets: false)
        defer { request.zeroize() }
        try removeBatch(backend, targets: request.items.map(\.target))
        success(
          operation: "REMOVE_BATCH",
          targets: request.items.map(\.target),
          compensationRequired: true
        )
      } else {
        throw PublicFailure("COMMAND_INVALID")
      }
    } catch let failure as PublicFailure {
      let operation =
        CommandLine.arguments.count == 2
        ? CommandLine.arguments[1].uppercased()
        : "UNKNOWN"
      failAndExit(failure, operation: operation)
    } catch {
      let operation =
        CommandLine.arguments.count == 2
        ? CommandLine.arguments[1].uppercased()
        : "UNKNOWN"
      failAndExit(PublicFailure("HELPER_FAILED"), operation: operation)
    }
  }
}

{{/*
Expand the name of the chart.
*/}}
{{- define "geo-query-ui.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified app name, truncated to the 63 chars a DNS label allows. A
release already carrying the chart name is used as-is, so `helm install
geo-query-ui` does not produce "geo-query-ui-geo-query-ui".
*/}}
{{- define "geo-query-ui.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "geo-query-ui.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "geo-query-ui.labels" -}}
helm.sh/chart: {{ include "geo-query-ui.chart" . }}
{{ include "geo-query-ui.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{ include "mclabels.labels" . }}
{{- end -}}

{{/*
Selector labels, and nothing else. Deliberately not including the mclabels
ones: a Deployment's selector is immutable, and a Service that selects on
labels the pods may not carry silently ends up with no endpoints — the route
answers "Application is not available" while the pod sits there passing its
probes. mclabels still go on the resources and the pods, via .labels above.
*/}}
{{- define "geo-query-ui.selectorLabels" -}}
app.kubernetes.io/name: {{ include "geo-query-ui.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
The image tag, defaulting to the chart's appVersion so a release is pinned to
the version it was packaged with unless one is named explicitly.
*/}}
{{- define "geo-query-ui.tag" -}}
{{- default (printf "v%s" .Chart.AppVersion) .Values.image.tag -}}
{{- end -}}

{{/*
Cloud provider settings come from the umbrella chart's `global` when it sets
them, and from this chart's own values otherwise.
*/}}
{{- define "geo-query-ui.cloudProviderFlavor" -}}
{{- if .Values.global.cloudProvider.flavor -}}
{{- .Values.global.cloudProvider.flavor -}}
{{- else if .Values.cloudProvider -}}
{{- .Values.cloudProvider.flavor | default "minikube" -}}
{{- else -}}
{{- "minikube" -}}
{{- end -}}
{{- end -}}

{{- define "geo-query-ui.cloudProviderDockerRegistryUrl" -}}
{{- if .Values.global.cloudProvider.dockerRegistryUrl -}}
{{- printf "%s/" .Values.global.cloudProvider.dockerRegistryUrl -}}
{{- else if .Values.cloudProvider.dockerRegistryUrl -}}
{{- printf "%s/" .Values.cloudProvider.dockerRegistryUrl -}}
{{- end -}}
{{- end -}}

{{- define "geo-query-ui.cloudProviderImagePullSecretName" -}}
{{- if .Values.global.cloudProvider.imagePullSecretName -}}
{{- .Values.global.cloudProvider.imagePullSecretName -}}
{{- else if .Values.cloudProvider.imagePullSecretName -}}
{{- .Values.cloudProvider.imagePullSecretName -}}
{{- end -}}
{{- end -}}

{{/*
Name of the ConfigMap holding the app's environment — an existing one when
given, so config maintained elsewhere can be used instead.
*/}}
{{- define "geo-query-ui.configMapName" -}}
{{- .Values.existingConfigMap | default (include "geo-query-ui.fullname" .) -}}
{{- end -}}

{{/*
Name of the Secret holding credentials the proxy map refers to, or empty when
there is none to mount.
*/}}
{{- define "geo-query-ui.secretName" -}}
{{- if .Values.secret.existingSecret -}}
{{- .Values.secret.existingSecret -}}
{{- else if and .Values.secret.create (or .Values.secret.data (compact (list .Values.env.api.apiKey .Values.env.wfs.apiKey .Values.env.wmts.apiKey))) -}}
{{- include "geo-query-ui.fullname" . -}}
{{- end -}}
{{- end -}}
